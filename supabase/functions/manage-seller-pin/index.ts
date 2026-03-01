import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const encryptionKey = Deno.env.get('ENCRYPTION_KEY')!;
    
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: 'No authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey);
    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { action, pin, seller_id } = await req.json();

    // Get seller profile
    const { data: sellerProfile, error: sellerError } = await supabaseClient
      .from('seller_profiles')
      .select('id, user_id, seller_pin_hash')
      .eq('user_id', user.id)
      .single();

    if (sellerError || !sellerProfile) {
      return new Response(
        JSON.stringify({ success: false, error: 'Seller profile not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Encrypt PIN using AES-GCM
    async function encryptPin(pin: string, sellerId: string): Promise<string> {
      const encoder = new TextEncoder();
      
      // Create key from ENCRYPTION_KEY + seller_id
      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(encryptionKey),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      
      const derivedKey = await crypto.subtle.sign(
        'HMAC',
        keyMaterial,
        encoder.encode(sellerId)
      );
      
      const aesKey = await crypto.subtle.importKey(
        'raw',
        derivedKey.slice(0, 32),
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );
      
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        encoder.encode(pin)
      );
      
      // Combine IV + encrypted data
      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(encrypted), iv.length);
      
      return btoa(String.fromCharCode(...combined));
    }

    async function decryptPin(encryptedPin: string, sellerId: string): Promise<string> {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      
      const combined = Uint8Array.from(atob(encryptedPin), c => c.charCodeAt(0));
      const iv = combined.slice(0, 12);
      const encrypted = combined.slice(12);
      
      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(encryptionKey),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      
      const derivedKey = await crypto.subtle.sign(
        'HMAC',
        keyMaterial,
        encoder.encode(sellerId)
      );
      
      const aesKey = await crypto.subtle.importKey(
        'raw',
        derivedKey.slice(0, 32),
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );
      
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        encrypted
      );
      
      return decoder.decode(decrypted);
    }

    if (action === 'set') {
      // Validate PIN is 8 digits
      if (!pin || !/^\d{8}$/.test(pin)) {
        return new Response(
          JSON.stringify({ success: false, error: 'PIN must be exactly 8 digits' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const encryptedPin = await encryptPin(pin, sellerProfile.id);

      const { error: updateError } = await supabaseClient
        .from('seller_profiles')
        .update({ seller_pin_hash: encryptedPin })
        .eq('id', sellerProfile.id);

      if (updateError) {
        console.error('Update error:', updateError);
        return new Response(
          JSON.stringify({ success: false, error: 'Failed to set PIN' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, message: 'PIN set successfully' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'verify') {
      if (!sellerProfile.seller_pin_hash) {
        return new Response(
          JSON.stringify({ success: false, error: 'No PIN set' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      try {
        const decryptedPin = await decryptPin(sellerProfile.seller_pin_hash, sellerProfile.id);
        const isValid = decryptedPin === pin;

        return new Response(
          JSON.stringify({ success: true, valid: isValid }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } catch (e) {
        console.error('Decryption error:', e);
        return new Response(
          JSON.stringify({ success: false, error: 'PIN verification failed' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    if (action === 'check') {
      // Check if PIN is set
      return new Response(
        JSON.stringify({ success: true, hasPin: !!sellerProfile.seller_pin_hash }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Admin recovery action
    if (action === 'admin_recover') {
      // Check if user is admin
      const { data: adminRole } = await supabaseClient
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .eq('role', 'admin')
        .single();

      if (!adminRole) {
        return new Response(
          JSON.stringify({ success: false, error: 'Admin access required' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (!seller_id) {
        return new Response(
          JSON.stringify({ success: false, error: 'Seller ID required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Get seller's encrypted PIN
      const { data: targetSeller } = await supabaseClient
        .from('seller_profiles')
        .select('id, seller_pin_hash, store_name')
        .eq('id', seller_id)
        .single();

      if (!targetSeller || !targetSeller.seller_pin_hash) {
        return new Response(
          JSON.stringify({ success: false, error: 'Seller has no PIN set' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      try {
        const decryptedPin = await decryptPin(targetSeller.seller_pin_hash, targetSeller.id);
        
        // Log the recovery action
        await supabaseClient.from('admin_logs').insert({
          admin_id: user.id,
          action: 'pin_recovery',
          target_type: 'seller_profile',
          target_id: seller_id,
          details: { store_name: targetSeller.store_name }
        });

        return new Response(
          JSON.stringify({ success: true, pin: decryptedPin }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } catch (e) {
        console.error('Recovery decryption error:', e);
        return new Response(
          JSON.stringify({ success: false, error: 'PIN recovery failed' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Admin remove PIN action with triple verification
    if (action === 'admin_remove') {
      // Check if user is admin
      const { data: adminRole } = await supabaseClient
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .eq('role', 'admin')
        .single();

      if (!adminRole) {
        return new Response(
          JSON.stringify({ success: false, error: 'Admin access required' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (!seller_id) {
        return new Response(
          JSON.stringify({ success: false, error: 'Seller ID required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Verify admin secret key
      const { adminSecretKey } = await req.json().catch(() => ({}));
      const adminPin = Deno.env.get('ADMIN_PIN');
      
      if (!adminSecretKey || adminSecretKey !== adminPin) {
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid Admin Secret Key' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Get seller info for logging
      const { data: targetSeller } = await supabaseClient
        .from('seller_profiles')
        .select('id, store_name')
        .eq('id', seller_id)
        .single();

      if (!targetSeller) {
        return new Response(
          JSON.stringify({ success: false, error: 'Seller not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Remove the PIN
      const { error: updateError } = await supabaseClient
        .from('seller_profiles')
        .update({ seller_pin_hash: null })
        .eq('id', seller_id);

      if (updateError) {
        console.error('Update error:', updateError);
        return new Response(
          JSON.stringify({ success: false, error: 'Failed to remove PIN' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Log the action
      await supabaseClient.from('admin_logs').insert({
        admin_id: user.id,
        action: 'remove_seller_pin',
        target_type: 'seller_profile',
        target_id: seller_id,
        details: { store_name: targetSeller.store_name, reason: 'Admin removed PIN with triple verification' }
      });

      return new Response(
        JSON.stringify({ success: true, message: 'Seller PIN removed successfully' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: 'Invalid action' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});