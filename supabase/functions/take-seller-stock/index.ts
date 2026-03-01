import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Derive encryption key using PBKDF2
async function deriveKey(secretKey: string, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

// Decrypt data
async function decryptData(encryptedBase64: string, secretKey: string, sellerId: string): Promise<string> {
  const encryptedBuffer = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
  const iv = encryptedBuffer.slice(0, 12);
  const ciphertext = encryptedBuffer.slice(12);

  const key = await deriveKey(secretKey, sellerId);
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decryptedBuffer);
}

// Fetch stock items in smaller sequential batches to avoid CPU timeout
async function fetchStockItems(
  supabaseAdmin: any,
  productId: string,
  quantity: number
): Promise<{ id: string; account_data: string }[]> {
  const BATCH_SIZE = 1000; // Larger batch size for efficient fetching
  const allItems: { id: string; account_data: string }[] = [];
  let offset = 0;

  while (allItems.length < quantity) {
    const remaining = quantity - allItems.length;
    const batchLimit = Math.min(BATCH_SIZE, remaining);
    
    const { data, error } = await supabaseAdmin
      .from('seller_product_stock')
      .select('id, account_data')
      .eq('product_id', productId)
      .eq('status', 1)
      .order('created_at', { ascending: true })
      .range(offset, offset + batchLimit - 1);

    if (error) {
      throw new Error('Failed to fetch stock items: ' + error.message);
    }

    if (!data || data.length === 0) {
      break; // No more items
    }

    allItems.push(...data);
    offset += data.length;

    // If we got less than batch size, there's no more data
    if (data.length < batchLimit) {
      break;
    }
  }

  return allItems.slice(0, quantity);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const ENCRYPTION_KEY = Deno.env.get('ENCRYPTION_KEY');
    if (!ENCRYPTION_KEY) {
      throw new Error('Encryption key not configured');
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Auth session missing');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // User client for auth
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    // Service client for data operations
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Get authenticated user
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      throw new Error('User not authenticated');
    }

    // Get seller profile
    const { data: sellerProfile, error: sellerError } = await supabaseUser
      .from('seller_profiles')
      .select('id')
      .eq('user_id', user.id)
      .single();

    if (sellerError || !sellerProfile) {
      throw new Error('Seller profile not found');
    }

    const { productId, quantity, label } = await req.json();

    if (!productId || !quantity || quantity < 1) {
      throw new Error('Invalid product ID or quantity');
    }

    // Limit maximum quantity per request to prevent timeout
    const MAX_QUANTITY = 50000;
    if (quantity > MAX_QUANTITY) {
      throw new Error(`Maximum ${MAX_QUANTITY} items per request. Please make multiple requests for larger quantities.`);
    }

    // Verify product belongs to seller
    const { data: product, error: productError } = await supabaseUser
      .from('seller_products')
      .select('id, name, seller_id')
      .eq('id', productId)
      .eq('seller_id', sellerProfile.id)
      .single();

    if (productError || !product) {
      throw new Error('Product not found or access denied');
    }

    console.log(`Starting take stock: ${quantity} items for product ${productId}`);

    // Get available stock items
    const stockItems = await fetchStockItems(supabaseAdmin, productId, quantity);

    if (!stockItems || stockItems.length === 0) {
      throw new Error('No available stock items');
    }

    if (stockItems.length < quantity) {
      throw new Error(`Only ${stockItems.length} items available, requested ${quantity}`);
    }

    console.log(`Fetched ${stockItems.length} items, starting decryption...`);

    // Decrypt stock items in smaller batches to avoid CPU timeout
    const DECRYPT_BATCH_SIZE = 500;
    const decryptedItems: string[] = [];
    const stockIds: string[] = [];

    for (let i = 0; i < stockItems.length; i += DECRYPT_BATCH_SIZE) {
      const batch = stockItems.slice(i, i + DECRYPT_BATCH_SIZE);
      
      for (const item of batch) {
        let decryptedText: string;

        try {
          // Current encryption salt: auth user id (seller user_id)
          decryptedText = await decryptData(item.account_data, ENCRYPTION_KEY, user.id);
        } catch (e1) {
          try {
            // Legacy fallback: seller profile id
            decryptedText = await decryptData(item.account_data, ENCRYPTION_KEY, sellerProfile.id);
          } catch (e2) {
            // Plain text fallback
            decryptedText = item.account_data;
          }
        }

        decryptedItems.push(decryptedText);
        stockIds.push(item.id);
      }
    }

    console.log(`Decrypted ${decryptedItems.length} items, updating status...`);

    // Mark stock items as taken (status = 3 for taken by seller)
    // Update in smaller batches
    const UPDATE_BATCH_SIZE = 500;
    for (let i = 0; i < stockIds.length; i += UPDATE_BATCH_SIZE) {
      const batchIds = stockIds.slice(i, i + UPDATE_BATCH_SIZE);
      const { error: updateError } = await supabaseAdmin
        .from('seller_product_stock')
        .update({ status: 3, sold_at: new Date().toISOString() })
        .in('id', batchIds);
      
      if (updateError) {
        console.error('Update error for batch:', updateError);
        throw new Error('Failed to update stock status');
      }
    }

    // Save to take stock history with optional label
    const stockDataText = decryptedItems.join('\n');
    const historyInsert: any = {
      seller_id: sellerProfile.id,
      product_id: productId,
      product_name: product.name,
      quantity: decryptedItems.length,
      stock_data: stockDataText
    };

    // Add label if provided
    if (label && typeof label === 'string' && label.trim()) {
      historyInsert.label = label.trim();
    }

    const { data: historyRecord, error: historyError } = await supabaseAdmin
      .from('take_stock_history')
      .insert(historyInsert)
      .select('id')
      .single();

    if (historyError) {
      console.error('History insert error:', historyError);
      // Don't fail the whole operation, stock was already taken
    }

    console.log(`Seller ${sellerProfile.id} took ${decryptedItems.length} stock items from product ${productId}`);

    return new Response(
      JSON.stringify({
        success: true,
        items: decryptedItems,
        quantity: decryptedItems.length,
        historyId: historyRecord?.id
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Take stock error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
