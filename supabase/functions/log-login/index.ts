import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface LoginLogRequest {
  email: string;
  success: boolean;
  failureReason?: string;
  userAgent?: string;
}

// SHA-256 hash for IP address privacy
async function hashIpAddress(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + Deno.env.get('ENCRYPTION_KEY'));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const authHeader = req.headers.get('Authorization');
    let userId: string | null = null;

    if (authHeader) {
      const { data: { user } } = await createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: authHeader } } }
      ).auth.getUser();
      userId = user?.id || null;
    }

    const body: LoginLogRequest = await req.json();
    const { email, success, failureReason, userAgent } = body;

    // Get real IP address from headers
    const forwardedFor = req.headers.get('x-forwarded-for');
    const realIp = req.headers.get('x-real-ip');
    const cfConnectingIp = req.headers.get('cf-connecting-ip');
    
    let ipAddress = cfConnectingIp || realIp || (forwardedFor ? forwardedFor.split(',')[0].trim() : null);
    
    // Fallback to get IP from external service if headers don't provide it
    if (!ipAddress || ipAddress === '127.0.0.1' || ipAddress === '::1') {
      try {
        const ipResponse = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipResponse.json();
        ipAddress = ipData.ip;
      } catch (e) {
        console.error('Failed to get IP:', e);
        ipAddress = 'Unknown';
      }
    }

    // Get geolocation from IP (this is stored, not the raw IP)
    let locationInfo = '';
    if (ipAddress && ipAddress !== 'Unknown') {
      try {
        const geoResponse = await fetch(`http://ip-api.com/json/${ipAddress}?fields=status,country,regionName,city`);
        const geoData = await geoResponse.json();
        if (geoData.status === 'success') {
          locationInfo = `${geoData.city}, ${geoData.regionName}, ${geoData.country}`;
        }
      } catch (e) {
        console.error('Failed to get geolocation:', e);
      }
    }

    // Hash the IP address for privacy - only store location info in readable form
    const ipHash = (ipAddress && ipAddress !== 'Unknown') 
      ? await hashIpAddress(ipAddress) 
      : 'Unknown';
    
    // Store location (readable) + hashed IP prefix for identification
    const displayIp = locationInfo 
      ? `${locationInfo} [${ipHash.substring(0, 8)}]` 
      : `[${ipHash.substring(0, 16)}]`;

    // Insert login log with hashed IP
    const { error: insertError } = await supabaseClient
      .from('login_logs')
      .insert({
        user_id: userId,
        email,
        ip_address: displayIp,  // Location + partial hash (no raw IP)
        ip_address_hash: ipHash, // Full hash for comparison
        user_agent: userAgent || req.headers.get('user-agent'),
        success,
        failure_reason: failureReason || null
      });

    if (insertError) {
      console.error('Failed to insert login log:', insertError);
      throw insertError;
    }

    // Update profile last_login_at if successful login
    if (success && userId) {
      await supabaseClient
        .from('profiles')
        .update({ last_login_at: new Date().toISOString() })
        .eq('user_id', userId);
    }

    console.log(`Login logged for ${email}: ${success ? 'success' : 'failed'} from ${displayIp}`);

    return new Response(
      JSON.stringify({ success: true, ip: displayIp }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error logging login:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
