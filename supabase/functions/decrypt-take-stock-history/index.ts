import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function deriveKey(secretKey: string, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
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
    ["decrypt"],
  );
}

async function decryptData(encryptedBase64: string, secretKey: string, salt: string): Promise<string> {
  const key = await deriveKey(secretKey, salt);

  const combined = Uint8Array.from(atob(encryptedBase64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encrypted,
  );

  return new TextDecoder().decode(decrypted);
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const ENCRYPTION_KEY = Deno.env.get('ENCRYPTION_KEY');
    if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY not configured');

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Auth session missing');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) throw new Error('User not authenticated');

    const { historyId } = await req.json();
    if (!historyId) throw new Error('historyId required');

    const { data: sellerProfile, error: sellerError } = await userClient
      .from('seller_profiles')
      .select('id')
      .eq('user_id', user.id)
      .single();

    if (sellerError || !sellerProfile) throw new Error('Seller profile not found');

    const { data: history, error: historyError } = await serviceClient
      .from('take_stock_history')
      .select('id, seller_id, product_name, quantity, stock_data, created_at')
      .eq('id', historyId)
      .eq('seller_id', sellerProfile.id)
      .single();

    if (historyError || !history) throw new Error('History record not found or access denied');

    const lines = splitLines(history.stock_data ?? '');

    const decryptedLines: string[] = [];
    let decryptedCount = 0;

    for (const line of lines) {
      if (!line) {
        decryptedLines.push(line);
        continue;
      }

      let out = line;
      try {
        // Current salt: seller auth user id
        out = await decryptData(line, ENCRYPTION_KEY, user.id);
        decryptedCount++;
      } catch (_e1) {
        try {
          // Legacy salt: seller profile id
          out = await decryptData(line, ENCRYPTION_KEY, sellerProfile.id);
          decryptedCount++;
        } catch (_e2) {
          // If not decryptable (already plain or not encrypted), keep as-is
          out = line;
        }
      }

      decryptedLines.push(out);
    }

    const decryptedText = decryptedLines.join('\n');

    console.log(
      `decrypt-take-stock-history: history=${historyId} seller=${sellerProfile.id} lines=${lines.length} decrypted=${decryptedCount}`,
    );

    return new Response(
      JSON.stringify({
        success: true,
        historyId,
        stock_data: decryptedText,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: any) {
    console.error('decrypt-take-stock-history error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error?.message ?? 'Unknown error' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
