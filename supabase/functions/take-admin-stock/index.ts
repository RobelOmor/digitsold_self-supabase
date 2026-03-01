import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Fetch stock items in parallel batches
async function fetchStockInBatches(
  supabaseAdmin: any,
  qualityId: string,
  quantity: number
): Promise<{ id: string; account_data: string }[]> {
  const BATCH_SIZE = 1000;
  const numBatches = Math.ceil(quantity / BATCH_SIZE);
  
  const batchPromises = Array.from({ length: numBatches }, (_, i) => {
    const offset = i * BATCH_SIZE;
    const remaining = quantity - offset;
    const batchLimit = Math.min(BATCH_SIZE, remaining);
    
    return supabaseAdmin
      .from('admin_account_stock')
      .select('id, account_data')
      .eq('quality_id', qualityId)
      .eq('status', 1)
      .order('created_at', { ascending: true })
      .range(offset, offset + batchLimit - 1);
  });

  const results = await Promise.all(batchPromises);
  
  const allItems: { id: string; account_data: string }[] = [];
  for (const { data, error } of results) {
    if (error) {
      throw new Error('Failed to fetch stock items: ' + error.message);
    }
    if (data && data.length > 0) {
      allItems.push(...data);
    }
  }

  return allItems.slice(0, quantity);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Auth session missing');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // User client for auth
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    // Service client for data operations
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Get authenticated user
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      throw new Error('User not authenticated');
    }

    // Verify user is admin
    const { data: adminRole, error: roleError } = await supabaseUser
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .single();

    if (roleError || !adminRole) {
      throw new Error('Admin access required');
    }

    const { qualityId, quantity } = await req.json();

    if (!qualityId || !quantity || quantity < 1) {
      throw new Error('Invalid quality ID or quantity');
    }

    // Get quality info
    const { data: quality, error: qualityError } = await supabaseAdmin
      .from('admin_account_qualities')
      .select('id, name')
      .eq('id', qualityId)
      .single();

    if (qualityError || !quality) {
      throw new Error('Quality not found');
    }

    // Get available stock items in batches
    const stockItems = await fetchStockInBatches(supabaseAdmin, qualityId, quantity);

    if (!stockItems || stockItems.length === 0) {
      throw new Error('No available stock items');
    }

    if (stockItems.length < quantity) {
      throw new Error(`Only ${stockItems.length} items available, requested ${quantity}`);
    }

    // Admin stock is not encrypted, just collect the data
    const items: string[] = [];
    const stockIds: string[] = [];

    for (const item of stockItems) {
      items.push(item.account_data);
      stockIds.push(item.id);
    }

    // Mark stock items as taken (status = 3)
    const UPDATE_BATCH_SIZE = 500;
    const updatePromises = [];
    for (let i = 0; i < stockIds.length; i += UPDATE_BATCH_SIZE) {
      const batchIds = stockIds.slice(i, i + UPDATE_BATCH_SIZE);
      updatePromises.push(
        supabaseAdmin
          .from('admin_account_stock')
          .update({ status: 3 })
          .in('id', batchIds)
      );
    }
    
    const updateResults = await Promise.all(updatePromises);
    for (const { error: updateError } of updateResults) {
      if (updateError) {
        console.error('Update error for batch:', updateError);
        throw new Error('Failed to update stock status');
      }
    }

    // Save to admin take stock history
    const stockDataText = items.join('\n');
    const { data: historyRecord, error: historyError } = await supabaseAdmin
      .from('admin_take_stock_history')
      .insert({
        quality_id: qualityId,
        quality_name: quality.name,
        quantity: items.length,
        stock_data: stockDataText
      })
      .select('id')
      .single();

    if (historyError) {
      console.error('History insert error:', historyError);
    }

    console.log(`Admin ${user.id} took ${items.length} stock items from quality ${qualityId}`);

    return new Response(
      JSON.stringify({
        success: true,
        items: items,
        quantity: items.length,
        historyId: historyRecord?.id
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Take admin stock error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
