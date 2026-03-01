import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// AES-256-GCM encryption using Web Crypto API
async function getEncryptionKey(secretKey: string, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secretKey),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encrypt(data: string, secretKey: string): Promise<string> {
  const salt = 'payment_methods_salt';
  const key = await getEncryptionKey(secretKey, salt);
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(data)
  );
  
  // Combine IV and encrypted data
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  
  // Convert to base64
  return btoa(String.fromCharCode(...combined));
}

async function decrypt(encryptedData: string, secretKey: string): Promise<string> {
  try {
    const salt = 'payment_methods_salt';
    const key = await getEncryptionKey(secretKey, salt);
    
    // Decode base64
    const combined = new Uint8Array(atob(encryptedData).split('').map(c => c.charCodeAt(0)));
    
    // Extract IV and encrypted data
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    );
    
    return new TextDecoder().decode(decrypted);
  } catch (error) {
    throw new Error('Decryption failed - invalid key');
  }
}

interface PaymentMethodRequest {
  action: 'list' | 'create' | 'update' | 'delete' | 'toggle' | 'get_decrypted' | 'get_active' | 'verify-key';
  secretKey?: string;
  pin?: string;
  data?: {
    id?: string;
    name?: string;
    method_type?: string;
    wallet_address?: string;
    icon?: string;
    is_active?: boolean;
    sort_order?: number;
    min_amount?: number;
    max_amount?: number;
    instructions?: string;
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const encryptionKey = Deno.env.get('ENCRYPTION_KEY');
    if (!encryptionKey) {
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: PaymentMethodRequest = await req.json();
    const { action, secretKey, pin, data } = body;

    // For verify-key action - verify ADMIN_PIN for withdrawal/admin actions
    if (action === 'verify-key') {
      const ADMIN_PIN = Deno.env.get('ADMIN_PIN');
      if (!ADMIN_PIN) {
        return new Response(
          JSON.stringify({ error: 'Server configuration error' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Check if the provided PIN matches ADMIN_PIN
      if (pin === ADMIN_PIN) {
        console.log('Admin PIN verified successfully');
        return new Response(
          JSON.stringify({ valid: true }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } else {
        console.log('Invalid admin PIN provided');
        return new Response(
          JSON.stringify({ valid: false, error: 'Invalid admin PIN' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // For get_active action - only requires user authentication (for buyers)
    if (action === 'get_active') {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) {
        return new Response(
          JSON.stringify({ error: 'Authorization required' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const supabaseUser = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: authHeader } } }
      );

      const { data: { user } } = await supabaseUser.auth.getUser();
      if (!user) {
        return new Response(
          JSON.stringify({ error: 'User not found' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Get active payment methods with decrypted wallet addresses
      const { data: methods, error } = await supabaseAdmin
        .from('payment_methods')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      if (error) throw error;

      const decryptedMethods = await Promise.all(
        (methods || []).map(async (method) => {
          try {
            const walletAddress = await decrypt(method.encrypted_data, encryptionKey);
            return {
              id: method.id,
              name: method.name,
              method_type: method.method_type,
              wallet_address: walletAddress,
              instructions: method.instructions,
              min_amount: method.min_amount,
              max_amount: method.max_amount,
              icon: method.icon,
              sort_order: method.sort_order
            };
          } catch (e) {
            console.error('Decryption error for method:', method.id);
            return null;
          }
        })
      );

      return new Response(
        JSON.stringify({ success: true, methods: decryptedMethods.filter(Boolean) }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // All other actions require admin authentication + secret key
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Authorization required' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user } } = await supabaseUser.auth.getUser();
    if (!user) {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check admin role
    const { data: roleData } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .maybeSingle();

    if (!roleData) {
      return new Response(
        JSON.stringify({ error: 'Admin access required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify secret key matches ENCRYPTION_KEY
    if (!secretKey || secretKey !== encryptionKey) {
      console.log('Invalid secret key provided');
      return new Response(
        JSON.stringify({ error: 'Invalid secret key' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Payment method action: ${action} by admin: ${user.id}`);

    switch (action) {
      case 'list': {
        const { data: methods, error } = await supabaseAdmin
          .from('payment_methods')
          .select('*')
          .order('sort_order', { ascending: true });

        if (error) throw error;

        // Decrypt wallet addresses for admin view
        const decryptedMethods = await Promise.all(
          (methods || []).map(async (method) => {
            try {
              const decrypted = await decrypt(method.encrypted_data, encryptionKey);
              return { ...method, wallet_address: decrypted };
            } catch (e) {
              return { ...method, wallet_address: '[Decryption Error]' };
            }
          })
        );

        return new Response(
          JSON.stringify({ success: true, data: decryptedMethods }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      case 'create': {
        if (!data?.name || !data?.method_type || !data?.wallet_address) {
          return new Response(
            JSON.stringify({ error: 'Name, method type, and wallet address are required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const encryptedData = await encrypt(data.wallet_address, encryptionKey);

        const { data: newMethod, error } = await supabaseAdmin
          .from('payment_methods')
          .insert({
            name: data.name,
            method_type: data.method_type,
            encrypted_data: encryptedData,
            icon: data.icon || null,
            is_active: data.is_active ?? true,
            sort_order: data.sort_order ?? 0,
            min_amount: data.min_amount ?? 10,
            max_amount: data.max_amount ?? 10000,
            instructions: data.instructions || null
          })
          .select()
          .single();

        if (error) throw error;

        console.log(`Created payment method: ${data.name}`);

        return new Response(
          JSON.stringify({ success: true, data: { ...newMethod, wallet_address: data.wallet_address } }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      case 'update': {
        if (!data?.id) {
          return new Response(
            JSON.stringify({ error: 'Payment method ID required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const updateData: Record<string, any> = {};
        if (data.name) updateData.name = data.name;
        if (data.method_type) updateData.method_type = data.method_type;
        if (data.wallet_address) updateData.encrypted_data = await encrypt(data.wallet_address, encryptionKey);
        if (data.icon !== undefined) updateData.icon = data.icon;
        if (data.is_active !== undefined) updateData.is_active = data.is_active;
        if (data.sort_order !== undefined) updateData.sort_order = data.sort_order;
        if (data.min_amount !== undefined) updateData.min_amount = data.min_amount;
        if (data.max_amount !== undefined) updateData.max_amount = data.max_amount;
        if (data.instructions !== undefined) updateData.instructions = data.instructions;

        const { data: updatedMethod, error } = await supabaseAdmin
          .from('payment_methods')
          .update(updateData)
          .eq('id', data.id)
          .select()
          .single();

        if (error) throw error;

        console.log(`Updated payment method: ${data.id}`);

        return new Response(
          JSON.stringify({ success: true, data: updatedMethod }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      case 'delete': {
        if (!data?.id) {
          return new Response(
            JSON.stringify({ error: 'Payment method ID required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const { error } = await supabaseAdmin
          .from('payment_methods')
          .delete()
          .eq('id', data.id);

        if (error) throw error;

        console.log(`Deleted payment method: ${data.id}`);

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      case 'toggle': {
        if (!data?.id || data.is_active === undefined) {
          return new Response(
            JSON.stringify({ error: 'Payment method ID and is_active status required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const { data: updatedMethod, error } = await supabaseAdmin
          .from('payment_methods')
          .update({ is_active: data.is_active })
          .eq('id', data.id)
          .select()
          .single();

        if (error) throw error;

        console.log(`Toggled payment method ${data.id} to ${data.is_active ? 'active' : 'inactive'}`);

        return new Response(
          JSON.stringify({ success: true, data: updatedMethod }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      case 'get_decrypted': {
        // For buyer use - decrypt a specific payment method
        if (!data?.id) {
          return new Response(
            JSON.stringify({ error: 'Payment method ID required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const { data: method, error } = await supabaseAdmin
          .from('payment_methods')
          .select('*')
          .eq('id', data.id)
          .eq('is_active', true)
          .single();

        if (error || !method) {
          return new Response(
            JSON.stringify({ error: 'Payment method not found' }),
            { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const walletAddress = await decrypt(method.encrypted_data, encryptionKey);

        return new Response(
          JSON.stringify({ 
            success: true, 
            data: { 
              ...method, 
              wallet_address: walletAddress,
              encrypted_data: undefined 
            } 
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      default:
        return new Response(
          JSON.stringify({ error: 'Invalid action' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

  } catch (error) {
    console.error('Error in manage-payment-methods:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
