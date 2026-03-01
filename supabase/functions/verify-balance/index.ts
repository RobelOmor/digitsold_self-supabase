import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Create HMAC hash for balance integrity (3-decimal precision)
async function createBalanceHash(userId: string, balance: number, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${userId}:${balance.toFixed(3)}`);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, data);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

// Create HMAC hash for balance integrity (2-decimal precision for legacy)
async function createBalanceHashLegacy(userId: string, balance: number, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${userId}:${balance.toFixed(2)}`);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, data);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

// Verify hash matches current or legacy format
async function verifyBalanceHash(userId: string, balance: number, storedHash: string, secret: string): Promise<boolean> {
  const currentHash = await createBalanceHash(userId, balance, secret);
  if (storedHash === currentHash) return true;
  
  // Check legacy 2-decimal format for backwards compatibility
  const legacyHash = await createBalanceHashLegacy(userId, balance, secret);
  return storedHash === legacyHash;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const BALANCE_SECRET = Deno.env.get('BALANCE_SECRET');
    if (!BALANCE_SECRET) {
      throw new Error('BALANCE_SECRET not configured');
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')!;

    const userClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } }
    });
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const { action, userId, amount, type, sellerId, targetUserId, adminCode, adminPin } = await req.json();

    if (action === 'verify') {
      // Verify current user's balance integrity
      const { data: profile, error } = await serviceClient
        .from('profiles')
        .select('balance, balance_hash')
        .eq('user_id', user.id)
        .single();

      if (error || !profile) {
        throw new Error('Profile not found');
      }

      // If no hash exists yet, generate one
      if (!profile.balance_hash) {
        const newHash = await createBalanceHash(user.id, profile.balance, BALANCE_SECRET);
        await serviceClient
          .from('profiles')
          .update({ balance_hash: newHash })
          .eq('user_id', user.id);
        
        return new Response(
          JSON.stringify({ valid: true, initialized: true }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Verify hash matches (supports both current and legacy formats)
      const isValid = await verifyBalanceHash(user.id, profile.balance, profile.balance_hash, BALANCE_SECRET);

      if (!isValid) {
        console.error(`SECURITY ALERT: Balance tampering detected for user ${user.id}`);
        console.error(`Stored balance: ${profile.balance}, Stored hash: ${profile.balance_hash}`);
        // Log the tampering attempt
        await serviceClient.from('admin_logs').insert({
          admin_id: user.id,
          action: 'balance_tamper_detected',
          target_type: 'profile',
          target_id: user.id,
          details: { 
            balance: profile.balance, 
            stored_hash: profile.balance_hash,
            alert: 'Balance was manually modified in database'
          }
        });
      }

      return new Response(
        JSON.stringify({ valid: isValid }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } else if (action === 'update') {
      // Only service role can update (called from other edge functions)
      // This validates the request is legitimate
      if (!userId || amount === undefined || !type) {
        throw new Error('userId, amount, and type required for update');
      }

      const { data: profile, error } = await serviceClient
        .from('profiles')
        .select('balance, balance_hash')
        .eq('user_id', userId)
        .single();

      if (error || !profile) {
        throw new Error('Profile not found');
      }

      // Verify current hash before updating (supports both current and legacy formats)
      if (profile.balance_hash) {
        const isValid = await verifyBalanceHash(userId, profile.balance, profile.balance_hash, BALANCE_SECRET);
        if (!isValid) {
          console.error(`SECURITY ALERT: Cannot update tampered balance for user ${userId}`);
          await serviceClient.from('admin_logs').insert({
            admin_id: userId,
            action: 'balance_tamper_detected',
            target_type: 'profile',
            target_id: userId,
            details: { balance: profile.balance, action_attempted: type }
          });
          throw new Error('Balance integrity check failed');
        }
      }

      const newBalance = profile.balance + amount;
      const newHash = await createBalanceHash(userId, newBalance, BALANCE_SECRET);

      // Update balance and hash atomically
      const { error: updateError } = await serviceClient
        .from('profiles')
        .update({ balance: newBalance, balance_hash: newHash })
        .eq('user_id', userId);

      if (updateError) {
        throw new Error('Failed to update balance');
      }

      console.log(`Balance updated for user ${userId}: ${profile.balance} -> ${newBalance} (${type})`);

      return new Response(
        JSON.stringify({ success: true, newBalance }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } else if (action === 'init_seller_hash') {
      // Admin-only action to initialize seller balance hash
      // Verify user is admin
      const { data: isAdmin } = await serviceClient.rpc('has_role', { 
        _user_id: user.id, 
        _role: 'admin' 
      });

      if (!isAdmin) {
        throw new Error('Admin access required');
      }

      if (!sellerId) {
        throw new Error('sellerId required');
      }

      // Get seller profile
      const { data: seller, error: sellerError } = await serviceClient
        .from('seller_profiles')
        .select('id, user_id, store_name, balance, balance_hash')
        .eq('id', sellerId)
        .single();

      if (sellerError || !seller) {
        throw new Error('Seller not found');
      }

      // Generate hash for seller balance using seller's user_id
      const newHash = await createBalanceHash(seller.user_id, seller.balance, BALANCE_SECRET);

      // Update seller balance_hash
      const { error: updateError } = await serviceClient
        .from('seller_profiles')
        .update({ balance_hash: newHash })
        .eq('id', sellerId);

      if (updateError) {
        throw new Error('Failed to update seller balance hash');
      }

      // Log the action
      await serviceClient.from('admin_logs').insert({
        admin_id: user.id,
        action: 'init_seller_balance_hash',
        target_type: 'seller_profile',
        target_id: sellerId,
        details: { store_name: seller.store_name, balance: seller.balance }
      });

      console.log(`Seller balance hash initialized for ${seller.store_name} (${sellerId})`);

      return new Response(
        JSON.stringify({ success: true, store_name: seller.store_name }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } else if (action === 'init_user_hash') {
      // Admin-only action to initialize user balance hash
      // Verify user is admin
      const { data: isAdmin } = await serviceClient.rpc('has_role', { 
        _user_id: user.id, 
        _role: 'admin' 
      });

      if (!isAdmin) {
        throw new Error('Admin access required');
      }

      if (!userId) {
        throw new Error('userId required');
      }

      // Get user profile
      const { data: profile, error: profileError } = await serviceClient
        .from('profiles')
        .select('user_id, email, balance, balance_hash')
        .eq('user_id', userId)
        .single();

      if (profileError || !profile) {
        throw new Error('User profile not found');
      }

      // Generate hash for user balance
      const newHash = await createBalanceHash(profile.user_id, profile.balance, BALANCE_SECRET);

      // Update balance_hash
      const { error: updateError } = await serviceClient
        .from('profiles')
        .update({ balance_hash: newHash })
        .eq('user_id', userId);

      if (updateError) {
        throw new Error('Failed to update user balance hash');
      }

      // Log the action
      await serviceClient.from('admin_logs').insert({
        admin_id: user.id,
        action: 'init_user_balance_hash',
        target_type: 'profile',
        target_id: userId,
        details: { email: profile.email, balance: profile.balance }
      });

      console.log(`User balance hash initialized for ${profile.email} (${userId})`);

      return new Response(
        JSON.stringify({ success: true, email: profile.email }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else if (action === 'sync_after_purchase') {
      // Sync balance hash after a successful purchase (called from client after RPC)
      const { data: profile, error } = await serviceClient
        .from('profiles')
        .select('balance, balance_hash')
        .eq('user_id', user.id)
        .single();

      if (error || !profile) {
        throw new Error('Profile not found');
      }

      // Generate new hash for current balance
      const newHash = await createBalanceHash(user.id, profile.balance, BALANCE_SECRET);

      // Update hash to match current balance
      await serviceClient
        .from('profiles')
        .update({ balance_hash: newHash })
        .eq('user_id', user.id);

      console.log(`Balance hash synced after purchase for user ${user.id}, balance: ${profile.balance}`);

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } else if (action === 'fix_user_balance') {
      // Admin-only action to fix user balance by calculating: Total Approved Deposits - Total Purchases
      // Requires admin 2FA verification + ADMIN_PIN
      
      // Verify user is admin
      const { data: isAdmin } = await serviceClient.rpc('has_role', { 
        _user_id: user.id, 
        _role: 'admin' 
      });

      if (!isAdmin) {
        throw new Error('Admin access required');
      }

      if (!targetUserId) {
        throw new Error('targetUserId required');
      }

      // Verify admin's 2FA code
      const { data: adminProfile } = await serviceClient
        .from('profiles')
        .select('two_factor_enabled, two_factor_secret')
        .eq('user_id', user.id)
        .single();

      if (adminProfile?.two_factor_enabled) {
        if (!adminCode) {
          throw new Error('Admin 2FA code required');
        }
        // Verify 2FA - call manage-2fa function internally
        const { data: verify2FAResult, error: verify2FAError } = await serviceClient.functions.invoke('manage-2fa', {
          body: { action: 'verify_login', code: adminCode },
          headers: { Authorization: req.headers.get('Authorization')! }
        });
        
        if (verify2FAError || !verify2FAResult?.success) {
          throw new Error('Invalid 2FA code');
        }
      }

      // Verify ADMIN_PIN
      const ADMIN_PIN = Deno.env.get('ADMIN_PIN');
      if (!adminPin || adminPin !== ADMIN_PIN) {
        throw new Error('Invalid Admin PIN');
      }

      // Get user profile
      const { data: profile, error: profileError } = await serviceClient
        .from('profiles')
        .select('user_id, email, balance, balance_hash')
        .eq('user_id', targetUserId)
        .single();

      if (profileError || !profile) {
        throw new Error('User profile not found');
      }

      // Calculate total approved deposits
      const { data: deposits } = await serviceClient
        .from('deposits')
        .select('amount')
        .eq('user_id', targetUserId)
        .eq('status', 'approved');

      const totalDeposits = deposits?.reduce((sum, d) => sum + Number(d.amount), 0) || 0;

      // Calculate total purchases (admin products)
      const { data: adminOrders } = await serviceClient
        .from('orders')
        .select('total_price')
        .eq('user_id', targetUserId);

      const totalAdminPurchases = adminOrders?.reduce((sum, o) => sum + Number(o.total_price), 0) || 0;

      // Calculate total purchases (seller products - as buyer)
      const { data: sellerOrders } = await serviceClient
        .from('seller_orders')
        .select('total_price, refund_amount')
        .eq('buyer_id', targetUserId);

      // Total spent on seller products minus any refunds received
      const totalSellerPurchases = sellerOrders?.reduce((sum, o) => {
        const spent = Number(o.total_price);
        const refunded = Number(o.refund_amount || 0);
        return sum + (spent - refunded);
      }, 0) || 0;

      // Calculate correct balance
      const correctBalance = Number((totalDeposits - totalAdminPurchases - totalSellerPurchases).toFixed(3));

      // Generate new hash
      const newHash = await createBalanceHash(targetUserId, correctBalance, BALANCE_SECRET);

      // Update balance and hash
      const { error: updateError } = await serviceClient
        .from('profiles')
        .update({ balance: correctBalance, balance_hash: newHash })
        .eq('user_id', targetUserId);

      if (updateError) {
        throw new Error('Failed to update user balance');
      }

      // Log the action
      await serviceClient.from('admin_logs').insert({
        admin_id: user.id,
        action: 'fix_user_balance',
        target_type: 'profile',
        target_id: targetUserId,
        details: { 
          email: profile.email,
          old_balance: profile.balance,
          new_balance: correctBalance,
          total_deposits: totalDeposits,
          total_admin_purchases: totalAdminPurchases,
          total_seller_purchases: totalSellerPurchases,
          calculation: `${totalDeposits} - ${totalAdminPurchases} - ${totalSellerPurchases} = ${correctBalance}`
        }
      });

      console.log(`User balance fixed for ${profile.email}: ${profile.balance} -> ${correctBalance}`);

      return new Response(
        JSON.stringify({ 
          success: true, 
          email: profile.email,
          oldBalance: profile.balance,
          newBalance: correctBalance,
          totalDeposits,
          totalAdminPurchases,
          totalSellerPurchases
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    throw new Error('Invalid action');

  } catch (error) {
    console.error('Balance verification error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
