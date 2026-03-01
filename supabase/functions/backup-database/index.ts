import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface BackupRequest {
  action: 'create_backup';
  adminSecretKey?: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const adminPin = Deno.env.get('ADMIN_PIN');

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: 'Authorization required' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid token' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      );
    }

    // Verify admin role
    const { data: adminRole } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .single();

    if (!adminRole) {
      return new Response(
        JSON.stringify({ success: false, error: 'Admin access required' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 403 }
      );
    }

    const { action, adminSecretKey } = await req.json() as BackupRequest;

    if (action === 'create_backup') {
      // Verify admin secret key
      if (adminSecretKey !== adminPin) {
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid Admin Secret Key' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      console.log('Starting database backup...');

      // Tables to backup
      const tables = [
        'profiles',
        'user_roles',
        'seller_profiles',
        'seller_products',
        'seller_product_stock',
        'seller_orders',
        'seller_balance_logs',
        'seller_withdrawals',
        'seller_applications',
        'categories',
        'subcategories',
        'products',
        'product_stock',
        'orders',
        'deposits',
        'balance_logs',
        'notifications',
        'support_tickets',
        'ticket_messages',
        'order_chats',
        'chat_messages',
        'site_settings',
        'payment_methods',
        'blogs',
        'blog_categories',
        'blacklist',
        'admin_logs',
        'login_logs',
        'rate_limits',
        'password_change_attempts',
        'user_sessions',
        'tg_marketing'
      ];

      const backupData: Record<string, any[]> = {};
      const errors: string[] = [];

      for (const table of tables) {
        try {
          const { data, error } = await supabase
            .from(table)
            .select('*');
          
          if (error) {
            errors.push(`${table}: ${error.message}`);
            console.error(`Error backing up ${table}:`, error);
          } else {
            backupData[table] = data || [];
            console.log(`Backed up ${table}: ${data?.length || 0} records`);
          }
        } catch (err: any) {
          errors.push(`${table}: ${err.message}`);
          console.error(`Exception backing up ${table}:`, err);
        }
      }

      // Calculate summary
      const summary = {
        timestamp: new Date().toISOString(),
        tables_backed_up: Object.keys(backupData).length,
        total_records: Object.values(backupData).reduce((sum, arr) => sum + arr.length, 0),
        errors: errors.length > 0 ? errors : null,
        table_counts: Object.fromEntries(
          Object.entries(backupData).map(([table, records]) => [table, records.length])
        )
      };

      // Log the backup action
      await supabase.from('admin_logs').insert({
        admin_id: user.id,
        action: 'database_backup',
        target_type: 'system',
        details: {
          tables_backed_up: summary.tables_backed_up,
          total_records: summary.total_records,
          timestamp: summary.timestamp
        }
      });

      console.log('Backup completed:', summary);

      return new Response(
        JSON.stringify({ 
          success: true, 
          backup: backupData,
          summary 
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: 'Invalid action' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    );

  } catch (error: any) {
    console.error('Backup error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
