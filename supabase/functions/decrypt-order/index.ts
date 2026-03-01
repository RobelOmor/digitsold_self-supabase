import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// AES-256-GCM decryption using Web Crypto API
async function deriveKey(secretKey: string, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
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

async function decryptData(encryptedBase64: string, secretKey: string, sellerId: string): Promise<string> {
  const key = await deriveKey(secretKey, sellerId);
  
  // Decode base64
  const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
  
  // Extract IV (first 12 bytes) and encrypted data
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);
  
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encrypted
  );

  return new TextDecoder().decode(decrypted);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const ENCRYPTION_KEY = Deno.env.get('ENCRYPTION_KEY');
    if (!ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY not configured');
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')!;
    
    // User client for auth
    const userClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } }
    });
    
    // Service client for fetching seller data
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // Get current user
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const { orderId, orderType, replacementOnly } = await req.json();

    if (!orderId) {
      throw new Error('orderId required');
    }

    let stockItems: any[] = [];
    let sellerUserId: string;

    if (orderType === 'seller') {
      // Seller product order
      const { data: order, error: orderError } = await userClient
        .from('seller_orders')
        .select('id, buyer_id, seller_id, download_count, max_downloads, quantity')
        .eq('id', orderId)
        .eq('buyer_id', user.id)
        .single();

      if (orderError || !order) {
        throw new Error('Order not found or access denied');
      }

      if (order.download_count >= order.max_downloads) {
        throw new Error('Maximum downloads exceeded');
      }

      // Get seller's user_id for decryption salt
      const { data: sellerProfile, error: sellerError } = await serviceClient
        .from('seller_profiles')
        .select('user_id')
        .eq('id', order.seller_id)
        .single();

      if (sellerError || !sellerProfile) {
        throw new Error('Seller not found');
      }

      sellerUserId = sellerProfile.user_id;

      // Get encrypted stock items
      const { data: stock, error: stockError } = await serviceClient
        .from('seller_product_stock')
        .select('account_data, sold_at')
        .eq('order_id', orderId)
        .order('sold_at');

      if (stockError) {
        throw new Error('Failed to fetch stock');
      }

      stockItems = stock || [];
      
      // If replacementOnly, get only items after original quantity
      if (replacementOnly) {
        const originalQuantity = order.quantity;
        stockItems = stockItems.slice(originalQuantity);
        
        if (stockItems.length === 0) {
          throw new Error('No replacement items available');
        }
      } else {
        // Original download - only get first 'quantity' items
        const originalQuantity = order.quantity;
        stockItems = stockItems.slice(0, originalQuantity);
      }

      // Update download count
      await serviceClient
        .from('seller_orders')
        .update({ download_count: order.download_count + 1 })
        .eq('id', orderId);

    } else {
      // Admin product order - these use product_stock table (not seller)
      const { data: order, error: orderError } = await userClient
        .from('orders')
        .select('id, user_id, download_count, max_downloads')
        .eq('id', orderId)
        .eq('user_id', user.id)
        .single();

      if (orderError || !order) {
        throw new Error('Order not found or access denied');
      }

      if (order.download_count >= order.max_downloads) {
        throw new Error('Maximum downloads exceeded');
      }

      // Admin products are not encrypted (legacy), return as-is
      const { data: stock, error: stockError } = await serviceClient
        .from('product_stock')
        .select('account_data')
        .eq('order_id', orderId)
        .order('sold_at');

      if (stockError) {
        throw new Error('Failed to fetch stock');
      }

      // Update download count
      await serviceClient
        .from('orders')
        .update({ download_count: order.download_count + 1 })
        .eq('id', orderId);

      // Return unencrypted data for admin products
      return new Response(
        JSON.stringify({ 
          success: true, 
          items: (stock || []).map(s => s.account_data)
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Decrypt seller product stock items
    const decryptedItems = await Promise.all(
      stockItems.map(async (item) => {
        try {
          return await decryptData(item.account_data, ENCRYPTION_KEY, sellerUserId);
        } catch (e) {
          console.error('Decryption failed for item, returning as-is:', e);
          // If decryption fails (old unencrypted data), return as-is
          return item.account_data;
        }
      })
    );

    console.log(`Decrypted ${decryptedItems.length} items for order ${orderId}${replacementOnly ? ' (replacement only)' : ''}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        items: decryptedItems
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Decryption error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
