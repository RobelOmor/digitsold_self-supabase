import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const adminPin = Deno.env.get('ADMIN_PIN')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Verify admin user
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Check if user is admin
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .single()

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { productId, approved, pin, adminNote } = await req.json()

    // Verify PIN
    if (pin !== adminPin) {
      console.log(`Invalid PIN attempt for product approval by admin: ${user.id}`)
      
      // Log failed attempt
      await supabase.from('admin_logs').insert({
        admin_id: user.id,
        action: 'product_approval_failed_pin',
        target_type: 'seller_product',
        target_id: productId,
        details: { reason: 'Invalid PIN' }
      })

      return new Response(JSON.stringify({ error: 'Invalid PIN' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Get product details
    const { data: product, error: productError } = await supabase
      .from('seller_products')
      .select('*, seller_profiles(store_name, user_id)')
      .eq('id', productId)
      .single()

    if (productError || !product) {
      return new Response(JSON.stringify({ error: 'Product not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Update product status
    const { error: updateError } = await supabase
      .from('seller_products')
      .update({ 
        is_active: approved,
        updated_at: new Date().toISOString()
      })
      .eq('id', productId)

    if (updateError) {
      console.error('Product update error:', updateError)
      return new Response(JSON.stringify({ error: 'Failed to update product' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Log admin action
    await supabase.from('admin_logs').insert({
      admin_id: user.id,
      action: approved ? 'product_approved' : 'product_rejected',
      target_type: 'seller_product',
      target_id: productId,
      details: { 
        product_name: product.name,
        seller_store: product.seller_profiles?.store_name,
        admin_note: adminNote || null
      }
    })

    // Notify seller
    if (product.seller_profiles?.user_id) {
      await supabase.from('notifications').insert({
        user_id: product.seller_profiles.user_id,
        title: approved ? 'Product Approved' : 'Product Rejected',
        message: approved 
          ? `Your product "${product.name}" has been approved and is now live!`
          : `Your product "${product.name}" was rejected. ${adminNote || 'Please contact support for details.'}`,
        type: approved ? 'success' : 'warning',
        link: `/seller/products`
      })
    }

    console.log(`Product ${productId} ${approved ? 'approved' : 'rejected'} by admin: ${user.id}`)

    return new Response(JSON.stringify({ 
      success: true,
      message: `Product ${approved ? 'approved' : 'rejected'} successfully`
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Product approval error:', error)
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
