import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Base32 encoding/decoding for TOTP secrets
const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Uint8Array): string {
  let result = '';
  let bits = 0;
  let value = 0;

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      result += base32Chars[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    result += base32Chars[(value << (5 - bits)) & 31];
  }

  return result;
}

function base32Decode(str: string): Uint8Array {
  str = str.toUpperCase().replace(/=+$/, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of str) {
    const idx = base32Chars.indexOf(char);
    if (idx === -1) continue;

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

// HMAC-SHA1 implementation using Web Crypto API
async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const keyBuffer = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
  const messageBuffer = message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer;
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageBuffer);
  return new Uint8Array(signature);
}

// Generate TOTP code
async function generateTOTP(secret: string, timeStep = 30, digits = 6): Promise<string> {
  const key = base32Decode(secret);
  const time = Math.floor(Date.now() / 1000 / timeStep);
  
  const timeBuffer = new Uint8Array(8);
  let t = time;
  for (let i = 7; i >= 0; i--) {
    timeBuffer[i] = t & 0xff;
    t = Math.floor(t / 256);
  }

  const hmac = await hmacSha1(key, timeBuffer);
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % Math.pow(10, digits);

  return code.toString().padStart(digits, '0');
}

// Verify TOTP code (with time window tolerance)
async function verifyTOTP(secret: string, code: string, window = 1): Promise<boolean> {
  for (let i = -window; i <= window; i++) {
    const time = Math.floor(Date.now() / 1000 / 30) + i;
    const timeBuffer = new Uint8Array(8);
    let t = time;
    for (let j = 7; j >= 0; j--) {
      timeBuffer[j] = t & 0xff;
      t = Math.floor(t / 256);
    }

    const key = base32Decode(secret);
    const hmac = await hmacSha1(key, timeBuffer);
    const offset = hmac[hmac.length - 1] & 0x0f;
    const generatedCode = (
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)
    ) % 1000000;

    if (generatedCode.toString().padStart(6, '0') === code) {
      return true;
    }
  }
  return false;
}

// Generate random secret
function generateSecret(): string {
  const buffer = new Uint8Array(20);
  crypto.getRandomValues(buffer);
  return base32Encode(buffer);
}

// Generate backup codes
function generateBackupCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const buffer = new Uint8Array(4);
    crypto.getRandomValues(buffer);
    const code = Array.from(buffer)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    codes.push(code.slice(0, 4) + '-' + code.slice(4, 8));
  }
  return codes;
}

// Hash a backup code for secure storage (SHA-256)
async function hashBackupCode(code: string): Promise<string> {
  const encoder = new TextEncoder();
  // Normalize: uppercase, remove dashes
  const normalizedCode = code.toUpperCase().replace(/-/g, '');
  const data = encoder.encode(normalizedCode);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Hash all backup codes for storage
async function hashBackupCodes(codes: string[]): Promise<string[]> {
  const hashedCodes: string[] = [];
  for (const code of codes) {
    const hashed = await hashBackupCode(code);
    hashedCodes.push(hashed);
  }
  return hashedCodes;
}

// Verify backup code and return remaining hashed codes if valid
async function verifyBackupCode(
  inputCode: string, 
  hashedCodes: string[]
): Promise<{ valid: boolean; remainingCodes: string[] }> {
  const inputHash = await hashBackupCode(inputCode);
  const index = hashedCodes.findIndex(h => h === inputHash);
  
  if (index === -1) {
    return { valid: false, remainingCodes: hashedCodes };
  }
  
  // Remove the used code
  const remainingCodes = [...hashedCodes];
  remainingCodes.splice(index, 1);
  return { valid: true, remainingCodes };
}

// Encrypt secret using AES-256-GCM
async function encryptSecret(secret: string, userId: string): Promise<string> {
  const encryptionKey = Deno.env.get('ENCRYPTION_KEY');
  if (!encryptionKey) throw new Error('Encryption key not configured');

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(encryptionKey + userId),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(userId),
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
    encoder.encode(secret)
  );

  const result = new Uint8Array(iv.length + new Uint8Array(encrypted).length);
  result.set(iv);
  result.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...result));
}

// Decrypt secret
async function decryptSecret(encryptedSecret: string, userId: string): Promise<string> {
  const encryptionKey = Deno.env.get('ENCRYPTION_KEY');
  if (!encryptionKey) throw new Error('Encryption key not configured');

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const data = new Uint8Array(atob(encryptedSecret).split('').map(c => c.charCodeAt(0)));
  const iv = data.slice(0, 12);
  const encrypted = data.slice(12);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(encryptionKey + userId),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(userId),
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get user from token
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { action, code, targetUserId } = await req.json();
    console.log(`2FA action: ${action} for user: ${user.id}`);

    // Check if admin for admin actions
    const isAdmin = async () => {
      const { data } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .eq('role', 'admin')
        .single();
      return !!data;
    };

    switch (action) {
      case 'generate_setup': {
        // Generate new 2FA secret for setup
        const secret = generateSecret();
        const encryptedSecret = await encryptSecret(secret, user.id);
        
        // Get user email for QR code
        const { data: profile } = await supabase
          .from('profiles')
          .select('email')
          .eq('user_id', user.id)
          .single();

        // Store encrypted secret temporarily (not enabled yet)
        await supabase
          .from('profiles')
          .update({ two_factor_secret: encryptedSecret })
          .eq('user_id', user.id);

        // Generate otpauth URL for QR code
        const issuer = 'DigitSold';
        const otpauthUrl = `otpauth://totp/${issuer}:${encodeURIComponent(profile?.email || user.email || 'user')}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

        return new Response(JSON.stringify({
          success: true,
          secret,
          otpauthUrl,
          qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(otpauthUrl)}`
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'verify_and_enable': {
        // Verify code and enable 2FA
        if (!code || code.length !== 6) {
          return new Response(JSON.stringify({ success: false, error: 'Invalid code format' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Get stored secret
        const { data: profile } = await supabase
          .from('profiles')
          .select('two_factor_secret')
          .eq('user_id', user.id)
          .single();

        if (!profile?.two_factor_secret) {
          return new Response(JSON.stringify({ success: false, error: 'No 2FA setup in progress' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Decrypt and verify
        const secret = await decryptSecret(profile.two_factor_secret, user.id);
        const isValid = await verifyTOTP(secret, code);

        if (!isValid) {
          return new Response(JSON.stringify({ success: false, error: 'Invalid verification code' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Generate backup codes (plain text for user)
        const backupCodes = generateBackupCodes();
        
        // Hash backup codes for secure storage
        const hashedBackupCodes = await hashBackupCodes(backupCodes);

        // Enable 2FA with hashed backup codes
        await supabase
          .from('profiles')
          .update({
            two_factor_enabled: true,
            two_factor_verified_at: new Date().toISOString(),
            two_factor_backup_codes: hashedBackupCodes  // Store HASHED codes, not plain text
          })
          .eq('user_id', user.id);

        return new Response(JSON.stringify({
          success: true,
          backupCodes,  // Return plain text codes to user (one-time display)
          message: '2FA enabled successfully'
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'verify_login': {
        // Verify 2FA code during login
        if (!code) {
          return new Response(JSON.stringify({ success: false, error: 'Code required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const { data: profile } = await supabase
          .from('profiles')
          .select('two_factor_secret, two_factor_enabled, two_factor_backup_codes')
          .eq('user_id', user.id)
          .single();

        if (!profile?.two_factor_enabled || !profile?.two_factor_secret) {
          return new Response(JSON.stringify({ success: true, message: '2FA not enabled' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // First try TOTP code
        const secret = await decryptSecret(profile.two_factor_secret, user.id);
        const isValidTOTP = await verifyTOTP(secret, code);

        if (isValidTOTP) {
          return new Response(JSON.stringify({ success: true, message: '2FA verified' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Check backup codes (stored as hashes)
        if (profile.two_factor_backup_codes && profile.two_factor_backup_codes.length > 0) {
          const { valid, remainingCodes } = await verifyBackupCode(code, profile.two_factor_backup_codes);
          
          if (valid) {
            // Update with remaining hashed codes
            await supabase
              .from('profiles')
              .update({ two_factor_backup_codes: remainingCodes })
              .eq('user_id', user.id);

            return new Response(JSON.stringify({ 
              success: true, 
              message: '2FA verified with backup code',
              backupCodesRemaining: remainingCodes.length
            }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }
        }

        return new Response(JSON.stringify({ success: false, error: 'Invalid 2FA code' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'disable': {
        // Disable 2FA (requires code verification)
        if (!code) {
          return new Response(JSON.stringify({ success: false, error: 'Code required to disable 2FA' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const { data: profile } = await supabase
          .from('profiles')
          .select('two_factor_secret')
          .eq('user_id', user.id)
          .single();

        if (!profile?.two_factor_secret) {
          return new Response(JSON.stringify({ success: false, error: '2FA not enabled' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const secret = await decryptSecret(profile.two_factor_secret, user.id);
        const isValid = await verifyTOTP(secret, code);

        if (!isValid) {
          return new Response(JSON.stringify({ success: false, error: 'Invalid code' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        await supabase
          .from('profiles')
          .update({
            two_factor_enabled: false,
            two_factor_secret: null,
            two_factor_backup_codes: null,
            two_factor_verified_at: null
          })
          .eq('user_id', user.id);

        return new Response(JSON.stringify({ success: true, message: '2FA disabled successfully' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'admin_disable': {
        // Admin can disable 2FA for any user (without triple verification - simple version)
        if (!await isAdmin()) {
          return new Response(JSON.stringify({ success: false, error: 'Admin access required' }), {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        if (!targetUserId) {
          return new Response(JSON.stringify({ success: false, error: 'Target user ID required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        await supabase
          .from('profiles')
          .update({
            two_factor_enabled: false,
            two_factor_secret: null,
            two_factor_backup_codes: null,
            two_factor_verified_at: null
          })
          .eq('user_id', targetUserId);

        // Log admin action
        await supabase
          .from('admin_logs')
          .insert({
            admin_id: user.id,
            action: 'disable_2fa',
            target_type: 'user',
            target_id: targetUserId,
            details: { reason: 'Admin disabled 2FA' }
          });

        return new Response(JSON.stringify({ success: true, message: '2FA disabled for user' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'admin_disable_with_verification': {
        // Admin can disable 2FA with triple verification (2FA + PIN + Admin Key verified on frontend)
        if (!await isAdmin()) {
          return new Response(JSON.stringify({ success: false, error: 'Admin access required' }), {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        if (!targetUserId) {
          return new Response(JSON.stringify({ success: false, error: 'Target user ID required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const { adminSecretKey } = await req.json().catch(() => ({}));
        const adminPin = Deno.env.get('ADMIN_PIN');
        
        if (!adminSecretKey || adminSecretKey !== adminPin) {
          return new Response(JSON.stringify({ success: false, error: 'Invalid Admin Secret Key' }), {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        await supabase
          .from('profiles')
          .update({
            two_factor_enabled: false,
            two_factor_secret: null,
            two_factor_backup_codes: null,
            two_factor_verified_at: null
          })
          .eq('user_id', targetUserId);

        // Log admin action
        await supabase
          .from('admin_logs')
          .insert({
            admin_id: user.id,
            action: 'disable_2fa_with_verification',
            target_type: 'user',
            target_id: targetUserId,
            details: { reason: 'Admin disabled 2FA with triple verification' }
          });

        return new Response(JSON.stringify({ success: true, message: '2FA disabled for user' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'get_status': {
        const { data: profile } = await supabase
          .from('profiles')
          .select('two_factor_enabled, two_factor_verified_at, two_factor_backup_codes')
          .eq('user_id', user.id)
          .single();

        return new Response(JSON.stringify({
          success: true,
          enabled: profile?.two_factor_enabled || false,
          verifiedAt: profile?.two_factor_verified_at,
          backupCodesRemaining: profile?.two_factor_backup_codes?.length || 0
        }), {
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
    console.error('2FA error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ success: false, error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
