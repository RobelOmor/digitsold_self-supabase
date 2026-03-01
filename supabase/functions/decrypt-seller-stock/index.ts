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

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function decryptWithKey(encryptedBase64: string, key: CryptoKey): Promise<string> {
  const combined = decodeBase64ToBytes(encryptedBase64);

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

async function decryptWithFallback(encrypted: string, keys: CryptoKey[]): Promise<string> {
  let lastError: unknown = null;
  for (const key of keys) {
    try {
      return await decryptWithKey(encrypted, key);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('Decryption failed');
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

    // Service client for fetching data
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // Get current user
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const { productId, limit, offset, fetchAll } = await req.json();

    if (!productId) {
      throw new Error('productId required');
    }

    const effectiveOffset = typeof offset === 'number' && offset >= 0 ? offset : 0;
    const effectiveLimit = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : undefined;

    // Verify the seller owns this product
    const { data: sellerProfile, error: sellerError } = await serviceClient
      .from('seller_profiles')
      .select('id, user_id')
      .eq('user_id', user.id)
      .single();

    if (sellerError || !sellerProfile) {
      throw new Error('Seller profile not found');
    }

    // Verify the product belongs to this seller
    const { data: product, error: productError } = await serviceClient
      .from('seller_products')
      .select('id, seller_id')
      .eq('id', productId)
      .eq('seller_id', sellerProfile.id)
      .single();

    if (productError || !product) {
      throw new Error('Product not found or access denied');
    }

    type StockRow = { account_data: string };

    // Get encrypted stock items for this product (only available stock, status = 1)
    // - limit: fetch a limited set (used by ViewStockDialog for fast UI)
    // - fetchAll: for large downloads, prefer pagination (limit+offset) from the client to avoid timeouts.
    let stockItems: StockRow[] = [];

    if (fetchAll) {
      // Count first so we can parallelize ranges
      const { count, error: countError } = await serviceClient
        .from('seller_product_stock')
        .select('id', { count: 'exact', head: true })
        .eq('product_id', productId)
        .eq('status', 1);

      if (countError) {
        throw new Error('Failed to count stock');
      }

      const totalAvailable = count ?? 0;
      const maxToFetch = Math.max(
        0,
        Math.min(
          effectiveLimit ?? totalAvailable,
          Math.max(0, totalAvailable - effectiveOffset)
        )
      );

      // Prevent very large single-request downloads (CPU timeouts / huge payload)
      if (maxToFetch > 2000) {
        throw new Error('Too many stock items for a single request. Please download in batches.');
      }

      if (maxToFetch === 0) {
        return new Response(
          JSON.stringify({ success: true, items: [] }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const BATCH_SIZE = 1000;
      const numBatches = Math.ceil(maxToFetch / BATCH_SIZE);

      const batchPromises = Array.from({ length: numBatches }, (_, i) => {
        const from = effectiveOffset + i * BATCH_SIZE;
        const to = Math.min(from + BATCH_SIZE - 1, effectiveOffset + maxToFetch - 1);

        return serviceClient
          .from('seller_product_stock')
          .select('account_data')
          .eq('product_id', productId)
          .eq('status', 1)
          .order('created_at', { ascending: true })
          .range(from, to);
      });

      const results = await Promise.all(batchPromises);

      for (const { data, error } of results) {
        if (error) {
          throw new Error('Failed to fetch stock');
        }
        if (data && data.length > 0) {
          stockItems.push(...(data as StockRow[]));
        }
      }

      stockItems = stockItems.slice(0, maxToFetch);
    } else {
      let query = serviceClient
        .from('seller_product_stock')
        .select('account_data')
        .eq('product_id', productId)
        .eq('status', 1)
        .order('created_at', { ascending: true });

      if (effectiveOffset > 0 && effectiveLimit) {
        query = query.range(effectiveOffset, effectiveOffset + effectiveLimit - 1);
      } else if (effectiveLimit) {
        query = query.limit(effectiveLimit);
      }

      const { data, error: stockError } = await query;

      if (stockError) {
        throw new Error('Failed to fetch stock');
      }

      stockItems = (data as StockRow[]) || [];
    }

    if (!stockItems || stockItems.length === 0) {
      return new Response(
        JSON.stringify({ success: true, items: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Derive keys once per request (massive speedup vs deriving per item)
    const keys: CryptoKey[] = [];
    keys.push(await deriveKey(ENCRYPTION_KEY, user.id));
    // Backwards compatibility: some older data might have used seller profile id as salt
    keys.push(await deriveKey(ENCRYPTION_KEY, sellerProfile.id));

    // Decrypt all stock items using pre-derived keys
    const decryptedItems = new Array<string>(stockItems.length);
    let nextIndex = 0;
    const CONCURRENCY = Math.min(50, stockItems.length);

    const worker = async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= stockItems.length) return;

        const item = stockItems[i];
        try {
          decryptedItems[i] = await decryptWithFallback(item.account_data, keys);
        } catch (e) {
          console.error('Decryption failed for item, returning as-is:', e);
          // If decryption fails (old unencrypted data), return as-is
          decryptedItems[i] = item.account_data;
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    console.log(`Decrypted ${decryptedItems.length} stock items for product ${productId}`);

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
