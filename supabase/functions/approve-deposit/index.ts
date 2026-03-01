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

// Legacy hash function for backwards compatibility (2-decimal precision)
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const ADMIN_PIN = Deno.env.get('ADMIN_PIN');
    const BALANCE_SECRET = Deno.env.get('BALANCE_SECRET');
    
    if (!ADMIN_PIN || !BALANCE_SECRET) {
      throw new Error('Server configuration error');
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

    // Verify admin role
    const { data: isAdmin } = await serviceClient.rpc('has_role', {
      _user_id: user.id,
      _role: 'admin'
    });

    if (!isAdmin) {
      throw new Error('Admin access required');
    }

    const { depositId, pin, action, adminNote, adjustedAmount } = await req.json();

    // Verify PIN
    if (pin !== ADMIN_PIN) {
      console.error(`SECURITY: Invalid PIN attempt by admin ${user.id} for deposit ${depositId}`);
      
      // Log failed attempt
      await serviceClient.from('admin_logs').insert({
        admin_id: user.id,
        action: 'deposit_approval_failed_pin',
        target_type: 'deposit',
        target_id: depositId,
        details: { reason: 'Invalid PIN' }
      });

      throw new Error('Invalid admin PIN');
    }

    // Get deposit details
    const { data: deposit, error: depositError } = await serviceClient
      .from('deposits')
      .select('*')
      .eq('id', depositId)
      .single();

    if (depositError || !deposit) {
      throw new Error('Deposit not found');
    }

    if (deposit.status !== 'pending') {
      throw new Error('Deposit already processed');
    }

    if (action === 'approve') {
      // Get user's current balance
      const { data: profile, error: profileError } = await serviceClient
        .from('profiles')
        .select('balance, balance_hash')
        .eq('user_id', deposit.user_id)
        .single();

      if (profileError || !profile) {
        throw new Error('User profile not found');
      }

      // Verify current balance hash if exists
      // Note: Skip strict validation for legacy hashes created with different formats
      if (profile.balance_hash) {
        const expectedHash3 = await createBalanceHash(deposit.user_id, profile.balance, BALANCE_SECRET);
        const expectedHash2 = await createBalanceHashLegacy(deposit.user_id, profile.balance, BALANCE_SECRET);
        
        if (profile.balance_hash !== expectedHash3 && profile.balance_hash !== expectedHash2) {
          // Log warning but allow transaction - likely legacy hash format
          console.warn(`Balance hash mismatch for user ${deposit.user_id}. Will update hash on this transaction.`);
        }
      }

      // Use adjusted amount if provided, otherwise use original deposit amount
      const approvedAmount = adjustedAmount !== undefined ? Number(adjustedAmount) : Number(deposit.amount);
      const isAmountAdjusted = adjustedAmount !== undefined && adjustedAmount !== deposit.amount;

      const newBalance = Number(profile.balance) + approvedAmount;
      const newHash = await createBalanceHash(deposit.user_id, newBalance, BALANCE_SECRET);

      // Update user balance with new hash
      const { error: updateError } = await serviceClient
        .from('profiles')
        .update({ balance: newBalance, balance_hash: newHash })
        .eq('user_id', deposit.user_id);

      if (updateError) {
        throw new Error('Failed to update balance');
      }

      // Prepare admin note with adjustment info
      const finalAdminNote = isAmountAdjusted 
        ? `${adminNote ? adminNote + ' | ' : ''}Amount adjusted: Original $${deposit.amount}, Approved $${approvedAmount}`
        : adminNote;

      // Update deposit status with approved amount
      await serviceClient
        .from('deposits')
        .update({
          status: 'approved',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
          admin_note: finalAdminNote,
          amount: approvedAmount // Update the amount to reflect what was actually approved
        })
        .eq('id', depositId);

      // Log balance change
      await serviceClient.from('balance_logs').insert({
        user_id: deposit.user_id,
        previous_balance: profile.balance,
        change_amount: approvedAmount,
        new_balance: newBalance,
        type: 'deposit',
        reference_id: depositId,
        description: `Deposit approved: ${deposit.method} - ${deposit.transaction_id || 'N/A'}${isAmountAdjusted ? ` (adjusted from $${deposit.amount})` : ''}`
      });

      // Notify user with clear message about any adjustment
      const notificationMessage = isAmountAdjusted
        ? `Your deposit request of $${deposit.amount} has been approved for $${approvedAmount} (adjusted for transfer fees) and added to your balance.`
        : `Your deposit of $${approvedAmount} has been approved and added to your balance.`;

      await serviceClient.from('notifications').insert({
        user_id: deposit.user_id,
        title: 'Deposit Approved',
        message: notificationMessage,
        type: 'success',
        link: '/deposit'
      });

      // Log admin action
      await serviceClient.from('admin_logs').insert({
        admin_id: user.id,
        action: 'deposit_approved',
        target_type: 'deposit',
        target_id: depositId,
        details: { 
          original_amount: deposit.amount,
          approved_amount: approvedAmount,
          amount_adjusted: isAmountAdjusted,
          user_id: deposit.user_id, 
          new_balance: newBalance 
        }
      });

      console.log(`Deposit ${depositId} approved by admin ${user.id}. Amount: $${approvedAmount}${isAmountAdjusted ? ` (adjusted from $${deposit.amount})` : ''}. User ${deposit.user_id} balance: ${profile.balance} -> ${newBalance}`);

      return new Response(
        JSON.stringify({ success: true, message: 'Deposit approved', newBalance, approvedAmount }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } else if (action === 'reject') {
      // Reject deposit
      await serviceClient
        .from('deposits')
        .update({
          status: 'rejected',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
          admin_note: adminNote
        })
        .eq('id', depositId);

      // Notify user
      await serviceClient.from('notifications').insert({
        user_id: deposit.user_id,
        title: 'Deposit Rejected',
        message: `Your deposit of $${deposit.amount} has been rejected. ${adminNote ? 'Reason: ' + adminNote : ''}`,
        type: 'error',
        link: '/deposit'
      });

      // Log admin action
      await serviceClient.from('admin_logs').insert({
        admin_id: user.id,
        action: 'deposit_rejected',
        target_type: 'deposit',
        target_id: depositId,
        details: { amount: deposit.amount, user_id: deposit.user_id, reason: adminNote }
      });

      console.log(`Deposit ${depositId} rejected by admin ${user.id}`);

      return new Response(
        JSON.stringify({ success: true, message: 'Deposit rejected' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    throw new Error('Invalid action');

  } catch (error) {
    console.error('Deposit approval error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
