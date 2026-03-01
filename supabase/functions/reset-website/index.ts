import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const resetSecretKey = Deno.env.get('RESET_SECRET_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify admin auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if user is admin
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .single();

    if (!roleData) {
      return new Response(
        JSON.stringify({ success: false, error: 'Admin access required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { secretKey } = await req.json();

    // Verify secret key
    if (secretKey !== resetSecretKey) {
      console.log('Invalid reset secret key attempt by admin:', user.email);
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid secret key' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Starting website reset by admin:', user.email);

    // Clear all user activity data in correct order (respecting foreign keys)
    // 1. Clear chat messages first (depends on order_chats)
    const { error: chatMsgError } = await supabase.from('chat_messages').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (chatMsgError) console.log('chat_messages clear error:', chatMsgError.message);

    // 2. Clear order chats (depends on seller_orders)
    const { error: orderChatsError } = await supabase.from('order_chats').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (orderChatsError) console.log('order_chats clear error:', orderChatsError.message);

    // 3. Clear ticket messages (depends on support_tickets)
    const { error: ticketMsgError } = await supabase.from('ticket_messages').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (ticketMsgError) console.log('ticket_messages clear error:', ticketMsgError.message);

    // 4. Clear support tickets
    const { error: ticketsError } = await supabase.from('support_tickets').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (ticketsError) console.log('support_tickets clear error:', ticketsError.message);

    // 5. Clear seller product stock (depends on seller_products)
    const { error: sellerStockError } = await supabase.from('seller_product_stock').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (sellerStockError) console.log('seller_product_stock clear error:', sellerStockError.message);

    // 6. Clear seller orders (depends on seller_products, seller_profiles)
    const { error: sellerOrdersError } = await supabase.from('seller_orders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (sellerOrdersError) console.log('seller_orders clear error:', sellerOrdersError.message);

    // 7. Clear seller balance logs (depends on seller_profiles)
    const { error: sellerBalanceLogsError } = await supabase.from('seller_balance_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (sellerBalanceLogsError) console.log('seller_balance_logs clear error:', sellerBalanceLogsError.message);

    // 8. Clear seller withdrawals (depends on seller_profiles)
    const { error: sellerWithdrawalsError } = await supabase.from('seller_withdrawals').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (sellerWithdrawalsError) console.log('seller_withdrawals clear error:', sellerWithdrawalsError.message);

    // 9. Clear seller products (depends on seller_profiles)
    const { error: sellerProductsError } = await supabase.from('seller_products').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (sellerProductsError) console.log('seller_products clear error:', sellerProductsError.message);

    // 10. Clear seller profiles
    const { error: sellerProfilesError } = await supabase.from('seller_profiles').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (sellerProfilesError) console.log('seller_profiles clear error:', sellerProfilesError.message);

    // 11. Clear seller applications
    const { error: sellerAppsError } = await supabase.from('seller_applications').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (sellerAppsError) console.log('seller_applications clear error:', sellerAppsError.message);

    // 12. Clear product stock (admin products)
    const { error: productStockError } = await supabase.from('product_stock').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (productStockError) console.log('product_stock clear error:', productStockError.message);

    // 13. Clear orders (admin products)
    const { error: ordersError } = await supabase.from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (ordersError) console.log('orders clear error:', ordersError.message);

    // 14. Clear deposits
    const { error: depositsError } = await supabase.from('deposits').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (depositsError) console.log('deposits clear error:', depositsError.message);

    // 15. Clear balance logs
    const { error: balanceLogsError } = await supabase.from('balance_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (balanceLogsError) console.log('balance_logs clear error:', balanceLogsError.message);

    // 16. Clear notifications
    const { error: notificationsError } = await supabase.from('notifications').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (notificationsError) console.log('notifications clear error:', notificationsError.message);

    // 17. Clear login logs
    const { error: loginLogsError } = await supabase.from('login_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (loginLogsError) console.log('login_logs clear error:', loginLogsError.message);

    // 18. Clear user sessions
    const { error: sessionsError } = await supabase.from('user_sessions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (sessionsError) console.log('user_sessions clear error:', sessionsError.message);

    // 19. Clear admin logs
    const { error: adminLogsError } = await supabase.from('admin_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (adminLogsError) console.log('admin_logs clear error:', adminLogsError.message);

    // 20. Clear blacklist
    const { error: blacklistError } = await supabase.from('blacklist').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (blacklistError) console.log('blacklist clear error:', blacklistError.message);

    // 21. Clear user roles (except admin roles)
    const { error: rolesError } = await supabase.from('user_roles').delete().neq('role', 'admin');
    if (rolesError) console.log('user_roles clear error:', rolesError.message);

    // 22. Clear profiles (except admin profiles)
    // First get admin user_ids
    const { data: adminRoles } = await supabase.from('user_roles').select('user_id').eq('role', 'admin');
    const adminUserIds = adminRoles?.map(r => r.user_id) || [];
    
    if (adminUserIds.length > 0) {
      const { error: profilesError } = await supabase.from('profiles').delete().not('user_id', 'in', `(${adminUserIds.join(',')})`);
      if (profilesError) console.log('profiles clear error:', profilesError.message);
    }

    console.log('Website reset completed successfully by admin:', user.email);

    return new Response(
      JSON.stringify({ success: true, message: 'Website data reset successfully' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('Reset website error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
