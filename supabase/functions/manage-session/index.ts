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
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Verify the user
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { action, deviceInfo, ipAddress, sessionToken } = await req.json()
    console.log(`Session action: ${action} for user: ${user.id}`)

    if (action === 'login') {
      // Invalidate all existing sessions for this user (single device)
      await supabase
        .from('user_sessions')
        .update({ is_active: false })
        .eq('user_id', user.id)
        .eq('is_active', true)

      // Generate new session token
      const newSessionToken = crypto.randomUUID()
      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000) // 12 hours

      // Create new session
      const { data: session, error: insertError } = await supabase
        .from('user_sessions')
        .insert({
          user_id: user.id,
          session_token: newSessionToken,
          device_info: deviceInfo || 'Unknown Device',
          ip_address: ipAddress || 'Unknown',
          expires_at: expiresAt.toISOString()
        })
        .select()
        .single()

      if (insertError) {
        console.error('Session insert error:', insertError)
        return new Response(JSON.stringify({ error: 'Failed to create session' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Log login
      await supabase.from('login_logs').insert({
        user_id: user.id,
        email: user.email || '',
        ip_address: ipAddress || 'Unknown',
        user_agent: deviceInfo || 'Unknown',
        success: true
      })

      console.log(`New session created for user: ${user.id}, expires: ${expiresAt}`)

      return new Response(JSON.stringify({ 
        success: true, 
        sessionToken: newSessionToken,
        expiresAt: expiresAt.toISOString()
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (action === 'validate') {
      // Check if session is valid and not expired
      const { data: session, error } = await supabase
        .from('user_sessions')
        .select('*')
        .eq('user_id', user.id)
        .eq('session_token', sessionToken)
        .eq('is_active', true)
        .gte('expires_at', new Date().toISOString())
        .single()

      if (error || !session) {
        console.log(`Invalid session for user: ${user.id}`)
        return new Response(JSON.stringify({ 
          valid: false, 
          reason: 'Session expired or logged in from another device' 
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      return new Response(JSON.stringify({ 
        valid: true,
        expiresAt: session.expires_at 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (action === 'logout') {
      // Invalidate specific session or all sessions
      if (sessionToken) {
        await supabase
          .from('user_sessions')
          .update({ is_active: false })
          .eq('user_id', user.id)
          .eq('session_token', sessionToken)
      } else {
        // Logout from all devices
        await supabase
          .from('user_sessions')
          .update({ is_active: false })
          .eq('user_id', user.id)
      }

      console.log(`User logged out: ${user.id}`)

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (action === 'logout_all') {
      await supabase
        .from('user_sessions')
        .update({ is_active: false })
        .eq('user_id', user.id)

      console.log(`All sessions invalidated for user: ${user.id}`)

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ error: 'Invalid action' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Session management error:', error)
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
