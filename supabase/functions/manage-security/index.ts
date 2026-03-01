import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SecurityRequest {
  action: 'set_security_answer' | 'verify_security_answer' | 'change_password' | 'get_attempts_count' | 'admin_verify_for_password_change' | 'admin_change_user_password';
  securityAnswer?: string;
  currentPassword?: string;
  newPassword?: string;
  secretKey?: string;
  twoFactorCode?: string;
  targetEmail?: string;
  targetUserId?: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: 'Authorization required' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get user from token
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { action, securityAnswer, currentPassword, newPassword, secretKey, twoFactorCode, targetEmail, targetUserId }: SecurityRequest = await req.json();

    // Hash function for security answer
    const hashAnswer = async (answer: string, userId: string): Promise<string> => {
      const encoder = new TextEncoder();
      const data = encoder.encode(answer.toLowerCase().trim() + userId);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    };

    // Admin verification for password change
    if (action === 'admin_verify_for_password_change') {
      // Check if user is admin
      const { data: adminRole } = await supabase
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

      // Verify secret key
      const adminPin = Deno.env.get('ADMIN_PIN');
      if (!secretKey || secretKey !== adminPin) {
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid admin secret key' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Verify admin 2FA
      const { data: adminProfile } = await supabase
        .from('profiles')
        .select('two_factor_secret, two_factor_enabled')
        .eq('user_id', user.id)
        .single();

      if (!adminProfile?.two_factor_enabled || !adminProfile?.two_factor_secret) {
        return new Response(
          JSON.stringify({ success: false, error: 'Admin 2FA not enabled' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Verify TOTP
      const { generateTOTP } = await import("https://deno.land/x/otp@v0.1.0/mod.ts");
      const secret = adminProfile.two_factor_secret;
      const expectedCode = generateTOTP(secret, { digits: 6, period: 30 });
      
      if (twoFactorCode !== expectedCode) {
        // Also check previous and next period for clock drift
        const prevCode = generateTOTP(secret, { digits: 6, period: 30, timestamp: Date.now() - 30000 });
        const nextCode = generateTOTP(secret, { digits: 6, period: 30, timestamp: Date.now() + 30000 });
        
        if (twoFactorCode !== prevCode && twoFactorCode !== nextCode) {
          return new Response(
            JSON.stringify({ success: false, error: 'Invalid 2FA code' }),
            { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }

      return new Response(
        JSON.stringify({ success: true, message: 'Verification successful' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Admin change user password
    if (action === 'admin_change_user_password') {
      if (!targetUserId || !newPassword) {
        return new Response(
          JSON.stringify({ success: false, error: 'Target user ID and new password required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Check if user is admin
      const { data: adminRole } = await supabase
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

      // Verify secret key again
      const adminPin = Deno.env.get('ADMIN_PIN');
      if (!secretKey || secretKey !== adminPin) {
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid admin secret key' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Verify admin 2FA again
      const { data: adminProfile } = await supabase
        .from('profiles')
        .select('two_factor_secret, two_factor_enabled')
        .eq('user_id', user.id)
        .single();

      if (!adminProfile?.two_factor_enabled || !adminProfile?.two_factor_secret) {
        return new Response(
          JSON.stringify({ success: false, error: 'Admin 2FA not enabled' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { generateTOTP } = await import("https://deno.land/x/otp@v0.1.0/mod.ts");
      const secret = adminProfile.two_factor_secret;
      const expectedCode = generateTOTP(secret, { digits: 6, period: 30 });
      
      if (twoFactorCode !== expectedCode) {
        const prevCode = generateTOTP(secret, { digits: 6, period: 30, timestamp: Date.now() - 30000 });
        const nextCode = generateTOTP(secret, { digits: 6, period: 30, timestamp: Date.now() + 30000 });
        
        if (twoFactorCode !== prevCode && twoFactorCode !== nextCode) {
          return new Response(
            JSON.stringify({ success: false, error: 'Invalid 2FA code' }),
            { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }

      // Get target user info
      const { data: targetProfile } = await supabase
        .from('profiles')
        .select('email, full_name')
        .eq('user_id', targetUserId)
        .single();

      if (!targetProfile) {
        return new Response(
          JSON.stringify({ success: false, error: 'Target user not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Change password using admin API
      const { error: updateError } = await supabase.auth.admin.updateUserById(
        targetUserId,
        { password: newPassword }
      );

      if (updateError) {
        console.error('Password update error:', updateError);
        return new Response(
          JSON.stringify({ success: false, error: 'Failed to update password' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Log admin action
      await supabase
        .from('admin_logs')
        .insert({
          admin_id: user.id,
          action: 'admin_password_change',
          target_type: 'user',
          target_id: targetUserId,
          details: { 
            target_email: targetProfile.email,
            target_name: targetProfile.full_name
          }
        });

      console.log(`Admin ${user.id} changed password for user ${targetUserId}`);

      return new Response(
        JSON.stringify({ success: true, message: 'Password changed successfully' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'set_security_answer') {
      if (!securityAnswer) {
        return new Response(
          JSON.stringify({ success: false, error: 'Security answer required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Check if already set
      const { data: profile } = await supabase
        .from('profiles')
        .select('security_answer_hash')
        .eq('user_id', user.id)
        .single();

      if (profile?.security_answer_hash) {
        return new Response(
          JSON.stringify({ success: false, error: 'Security answer already set. Contact support to change.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const hashedAnswer = await hashAnswer(securityAnswer, user.id);

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ 
          security_answer_hash: hashedAnswer,
          security_answer_set_at: new Date().toISOString()
        })
        .eq('user_id', user.id);

      if (updateError) {
        console.error('Update error:', updateError);
        return new Response(
          JSON.stringify({ success: false, error: 'Failed to set security answer' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, message: 'Security answer set successfully' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'get_attempts_count') {
      // Get count of password change attempts this month
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const { count } = await supabase
        .from('password_change_attempts')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('created_at', startOfMonth.toISOString());

      return new Response(
        JSON.stringify({ success: true, count: count || 0, limit: 10 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'change_password') {
      if (!newPassword) {
        return new Response(
          JSON.stringify({ success: false, error: 'New password required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Check monthly limit
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const { count } = await supabase
        .from('password_change_attempts')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('created_at', startOfMonth.toISOString());

      if ((count || 0) >= 10) {
        return new Response(
          JSON.stringify({ success: false, error: 'Monthly password change limit reached (10/month). Try next month.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      let verified = false;
      let method = '';

      // Verify using security answer
      if (securityAnswer) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('security_answer_hash')
          .eq('user_id', user.id)
          .single();

        if (profile?.security_answer_hash) {
          const hashedAnswer = await hashAnswer(securityAnswer, user.id);
          if (hashedAnswer === profile.security_answer_hash) {
            verified = true;
            method = 'security_question';
          }
        }
      }

      // Verify using current password
      if (!verified && currentPassword) {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: user.email!,
          password: currentPassword
        });

        if (!signInError) {
          verified = true;
          method = 'current_password';
        }
      }

      // Log the attempt
      await supabase
        .from('password_change_attempts')
        .insert({
          user_id: user.id,
          success: verified,
          method: method || 'failed'
        });

      if (!verified) {
        return new Response(
          JSON.stringify({ success: false, error: 'Verification failed. Provide correct security answer or current password.' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Change password using admin API
      const { error: updateError } = await supabase.auth.admin.updateUserById(
        user.id,
        { password: newPassword }
      );

      if (updateError) {
        console.error('Password update error:', updateError);
        return new Response(
          JSON.stringify({ success: false, error: 'Failed to update password' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, message: 'Password changed successfully' }),
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
