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

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { action } = await req.json()

    if (action === 'check') {
      // Check if user is in cooldown
      const { data: profile } = await supabase
        .from('profiles')
        .select('suspicious_refresh_count, refresh_cooldown_until')
        .eq('user_id', user.id)
        .single()

      if (profile?.refresh_cooldown_until) {
        const cooldownUntil = new Date(profile.refresh_cooldown_until)
        if (cooldownUntil > new Date()) {
          const remainingSeconds = Math.ceil((cooldownUntil.getTime() - Date.now()) / 1000)
          return new Response(JSON.stringify({ 
            inCooldown: true,
            remainingSeconds,
            cooldownUntil: profile.refresh_cooldown_until
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }
      }

      return new Response(JSON.stringify({ inCooldown: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (action === 'track') {
      // Get current refresh count
      const { data: profile } = await supabase
        .from('profiles')
        .select('suspicious_refresh_count, refresh_cooldown_until')
        .eq('user_id', user.id)
        .single()

      // Check if already in cooldown
      if (profile?.refresh_cooldown_until) {
        const cooldownUntil = new Date(profile.refresh_cooldown_until)
        if (cooldownUntil > new Date()) {
          const remainingSeconds = Math.ceil((cooldownUntil.getTime() - Date.now()) / 1000)
          return new Response(JSON.stringify({ 
            inCooldown: true,
            remainingSeconds,
            cooldownUntil: profile.refresh_cooldown_until
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }
      }

      const currentCount = profile?.suspicious_refresh_count || 0
      const newCount = currentCount + 1

      // If refresh count exceeds threshold (5 refreshes), trigger cooldown
      if (newCount >= 5) {
        // Random cooldown between 3-5 minutes
        const cooldownMinutes = 3 + Math.random() * 2
        const cooldownUntil = new Date(Date.now() + cooldownMinutes * 60 * 1000)

        await supabase
          .from('profiles')
          .update({ 
            suspicious_refresh_count: 0,
            refresh_cooldown_until: cooldownUntil.toISOString()
          })
          .eq('user_id', user.id)

        console.log(`User ${user.id} triggered cooldown for ${cooldownMinutes.toFixed(1)} minutes`)

        // Log suspicious activity
        await supabase.from('admin_logs').insert({
          admin_id: user.id,
          action: 'suspicious_refresh_detected',
          target_type: 'user',
          target_id: user.id,
          details: { 
            refresh_count: newCount,
            cooldown_minutes: cooldownMinutes.toFixed(1)
          }
        })

        return new Response(JSON.stringify({ 
          inCooldown: true,
          remainingSeconds: Math.ceil(cooldownMinutes * 60),
          cooldownUntil: cooldownUntil.toISOString(),
          message: 'Too many page refreshes detected. Please wait.'
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Just increment count
      await supabase
        .from('profiles')
        .update({ suspicious_refresh_count: newCount })
        .eq('user_id', user.id)

      return new Response(JSON.stringify({ 
        inCooldown: false,
        refreshCount: newCount
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (action === 'reset') {
      // Reset refresh count (called on normal navigation)
      await supabase
        .from('profiles')
        .update({ suspicious_refresh_count: 0 })
        .eq('user_id', user.id)

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ error: 'Invalid action' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Refresh tracking error:', error)
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
