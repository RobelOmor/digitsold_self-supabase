import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Generate SHA-256 hash for duplicate detection
async function generateHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content.toLowerCase().trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// AES-256-GCM encryption using Web Crypto API
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
    ["encrypt"]
  );
}

async function encryptData(plaintext: string, secretKey: string, sellerId: string): Promise<string> {
  const key = await deriveKey(secretKey, sellerId);
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
  
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext)
  );

  // Combine IV + encrypted data and encode as base64
  const combined = new Uint8Array(iv.length + new Uint8Array(encrypted).length);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  
  return btoa(String.fromCharCode(...combined));
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

    // Extract JWT token from Bearer header
    const jwt = authHeader.replace('Bearer ', '');
    console.log('Received JWT token (first 20 chars):', jwt.substring(0, 20));

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    // Create admin client with service role key
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Verify JWT and get user using service role client
    const { data: { user }, error: userError } = await supabase.auth.getUser(jwt);
    if (userError || !user) {
      console.error('Auth error:', userError);
      throw new Error('Unauthorized: ' + (userError?.message || 'Invalid token'));
    }

    console.log('Authenticated user:', user.id);

    const { productId, stockItems } = await req.json();

    if (!productId || !stockItems || !Array.isArray(stockItems)) {
      throw new Error('Invalid input: productId and stockItems array required');
    }

    // Verify user owns this product (is the seller)
    const { data: product, error: productError } = await supabase
      .from('seller_products')
      .select('seller_id, seller_profiles!inner(user_id)')
      .eq('id', productId)
      .single();

    if (productError || !product) {
      throw new Error('Product not found');
    }

    const sellerUserId = (product as any).seller_profiles?.user_id;
    if (sellerUserId !== user.id) {
      throw new Error('Not authorized to add stock to this product');
    }

    // Generate hashes for all incoming items
    const itemsWithHashes = await Promise.all(
      stockItems.map(async (item: string) => ({
        content: item.trim(),
        hash: await generateHash(item)
      }))
    );

    // Get existing hashes for this product to check duplicates
    const { data: existingHashes, error: hashError } = await supabase
      .from('seller_product_stock')
      .select('content_hash')
      .eq('product_id', productId)
      .not('content_hash', 'is', null);

    if (hashError) {
      console.error('Error fetching existing hashes:', hashError);
    }

    const existingHashSet = new Set(existingHashes?.map(h => h.content_hash) || []);
    console.log(`Found ${existingHashSet.size} existing hashes for product ${productId}`);

    // Filter out duplicates
    const uniqueItems = itemsWithHashes.filter(item => !existingHashSet.has(item.hash));
    const duplicatesSkipped = itemsWithHashes.length - uniqueItems.length;
    
    console.log(`Skipping ${duplicatesSkipped} duplicates, inserting ${uniqueItems.length} unique items`);

    if (uniqueItems.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          count: 0,
          duplicatesSkipped,
          message: `All ${duplicatesSkipped} items were duplicates and skipped`
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Encrypt each unique stock item using seller's UUID as salt
    const encryptedItems = await Promise.all(
      uniqueItems.map(async (item) => {
        const encrypted = await encryptData(item.content, ENCRYPTION_KEY, user.id);
        return {
          product_id: productId,
          account_data: encrypted,
          content_hash: item.hash,
          status: 1
        };
      })
    );

    // Insert encrypted stock
    const { data: insertedStock, error: insertError } = await supabase
      .from('seller_product_stock')
      .insert(encryptedItems)
      .select();

    if (insertError) {
      console.error('Insert error:', insertError);
      throw new Error('Failed to insert stock');
    }

    console.log(`Encrypted and inserted ${encryptedItems.length} stock items for product ${productId}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        count: encryptedItems.length,
        duplicatesSkipped,
        message: `Successfully added ${encryptedItems.length} encrypted stock items (${duplicatesSkipped} duplicates skipped)`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Encryption error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});