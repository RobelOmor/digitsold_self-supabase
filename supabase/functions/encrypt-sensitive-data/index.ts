import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// AES-256-GCM Encryption
async function encryptData(plainText: string, salt: string): Promise<string> {
  const encryptionKey = Deno.env.get('ENCRYPTION_KEY');
  if (!encryptionKey) throw new Error('Encryption key not configured');

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(encryptionKey + salt),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plainText)
  );

  const result = new Uint8Array(iv.length + new Uint8Array(encrypted).length);
  result.set(iv);
  result.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...result));
}

// AES-256-GCM Decryption
async function decryptData(encryptedData: string, salt: string): Promise<string> {
  const encryptionKey = Deno.env.get('ENCRYPTION_KEY');
  if (!encryptionKey) throw new Error('Encryption key not configured');

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const data = new Uint8Array(atob(encryptedData).split('').map(c => c.charCodeAt(0)));
  const iv = data.slice(0, 12);
  const encrypted = data.slice(12);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(encryptionKey + salt),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encrypted
  );

  return decoder.decode(decrypted);
}

// SHA-256 Hash for IP addresses
async function hashData(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// HMAC hash for balance verification
async function generateBalanceHash(balance: number, identifier: string): Promise<string> {
  const balanceSecret = Deno.env.get('BALANCE_SECRET');
  if (!balanceSecret) throw new Error('Balance secret not configured');

  const encoder = new TextEncoder();
  const data = encoder.encode(balance.toFixed(3) + identifier + balanceSecret);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: 'Missing authorization' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json();
    const { action, data, salt, recordId, dataType, walletAddress, telegramId } = body;
    console.log(`Encrypt action: ${action}, dataType: ${dataType}`);

    switch (action) {
      case 'encrypt': {
        if (!data || !salt) {
          return new Response(JSON.stringify({ success: false, error: 'Data and salt required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const encrypted = await encryptData(data, salt);
        return new Response(JSON.stringify({ success: true, encrypted }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'decrypt': {
        if (!data || !salt) {
          return new Response(JSON.stringify({ success: false, error: 'Data and salt required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        try {
          const decrypted = await decryptData(data, salt);
          return new Response(JSON.stringify({ success: true, decrypted }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: 'Decryption failed' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      }

      case 'hash': {
        if (!data) {
          return new Response(JSON.stringify({ success: false, error: 'Data required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const hashed = await hashData(data);
        return new Response(JSON.stringify({ success: true, hashed }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'generate_balance_hash': {
        if (data === undefined || !salt) {
          return new Response(JSON.stringify({ success: false, error: 'Balance and identifier required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const hash = await generateBalanceHash(parseFloat(data), salt);
        return new Response(JSON.stringify({ success: true, hash }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'encrypt_wallet_address': {
        // Encrypt wallet address for deposit or withdrawal
        const addressToEncrypt = walletAddress || data;
        if (!addressToEncrypt || !recordId) {
          return new Response(JSON.stringify({ success: false, error: 'walletAddress and recordId required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const encrypted = await encryptData(addressToEncrypt, recordId);
        console.log(`Wallet address encrypted for recordId: ${recordId}`);

        return new Response(JSON.stringify({ success: true, encrypted }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'decrypt_wallet_address': {
        // Decrypt wallet address for viewing
        if (!recordId || !dataType) {
          return new Response(JSON.stringify({ success: false, error: 'RecordId and dataType required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Check if user is admin or owner
        const { data: roleData } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', user.id)
          .eq('role', 'admin')
          .single();

        let encryptedData: string | null = null;

        if (dataType === 'deposit') {
          const { data: deposit } = await supabase
            .from('deposits')
            .select('wallet_address_encrypted, user_id')
            .eq('id', recordId)
            .single();

          if (!deposit) {
            return new Response(JSON.stringify({ success: false, error: 'Deposit not found' }), {
              status: 404,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

          // Only admin or owner can decrypt
          if (!roleData && deposit.user_id !== user.id) {
            return new Response(JSON.stringify({ success: false, error: 'Access denied' }), {
              status: 403,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

          encryptedData = deposit.wallet_address_encrypted;
        } else if (dataType === 'withdrawal') {
          const { data: withdrawal } = await supabase
            .from('seller_withdrawals')
            .select('wallet_address_encrypted, seller_id')
            .eq('id', recordId)
            .single();

          if (!withdrawal) {
            return new Response(JSON.stringify({ success: false, error: 'Withdrawal not found' }), {
              status: 404,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

          // Check if user owns this seller profile
          const { data: sellerProfile } = await supabase
            .from('seller_profiles')
            .select('user_id')
            .eq('id', withdrawal.seller_id)
            .single();

          if (!roleData && sellerProfile?.user_id !== user.id) {
            return new Response(JSON.stringify({ success: false, error: 'Access denied' }), {
              status: 403,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

          encryptedData = withdrawal.wallet_address_encrypted;
        }

        if (!encryptedData) {
          return new Response(JSON.stringify({ success: true, decrypted: null }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const decrypted = await decryptData(encryptedData, recordId);
        return new Response(JSON.stringify({ success: true, decrypted }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'encrypt_telegram': {
        // Encrypt telegram ID for profiles or seller_profiles
        if (!data || !dataType) {
          return new Response(JSON.stringify({ success: false, error: 'Data and dataType required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const encrypted = await encryptData(data, user.id);

        if (dataType === 'profile') {
          await supabase
            .from('profiles')
            .update({ telegram_id_encrypted: encrypted })
            .eq('user_id', user.id);
        } else if (dataType === 'seller') {
          await supabase
            .from('seller_profiles')
            .update({ telegram_contact_encrypted: encrypted })
            .eq('user_id', user.id);
        }

        return new Response(JSON.stringify({ success: true, message: 'Telegram encrypted' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'decrypt_telegram': {
        // Decrypt telegram for viewing
        if (!dataType) {
          return new Response(JSON.stringify({ success: false, error: 'DataType required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        let encryptedData: string | null = null;
        let targetUserId = user.id;

        // Admin can view any user's telegram
        const { data: roleData } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', user.id)
          .eq('role', 'admin')
          .single();

        if (roleData && recordId) {
          targetUserId = recordId;
        }

        if (dataType === 'profile') {
          const { data: profile } = await supabase
            .from('profiles')
            .select('telegram_id_encrypted')
            .eq('user_id', targetUserId)
            .single();
          encryptedData = profile?.telegram_id_encrypted;
        } else if (dataType === 'seller') {
          const { data: seller } = await supabase
            .from('seller_profiles')
            .select('telegram_contact_encrypted')
            .eq('user_id', targetUserId)
            .single();
          encryptedData = seller?.telegram_contact_encrypted;
        }

        if (!encryptedData) {
          return new Response(JSON.stringify({ success: true, decrypted: null }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const decrypted = await decryptData(encryptedData, targetUserId);
        return new Response(JSON.stringify({ success: true, decrypted }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'update_pending_balance_hash': {
        // Update pending balance hash for seller
        const { data: seller } = await supabase
          .from('seller_profiles')
          .select('id, pending_balance')
          .eq('user_id', user.id)
          .single();

        if (!seller) {
          return new Response(JSON.stringify({ success: false, error: 'Seller not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const hash = await generateBalanceHash(seller.pending_balance, seller.id);
        await supabase
          .from('seller_profiles')
          .update({ pending_balance_hash: hash })
          .eq('id', seller.id);

        return new Response(JSON.stringify({ success: true, message: 'Pending balance hash updated' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      default:
        return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
  } catch (error: unknown) {
    console.error('Encryption error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ success: false, error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
