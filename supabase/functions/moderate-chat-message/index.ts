import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { message } = await req.json();
    
    if (!message || typeof message !== 'string') {
      return new Response(
        JSON.stringify({ allowed: true, reason: '' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    if (!OPENAI_API_KEY) {
      console.log('OpenAI API key not configured, allowing message');
      return new Response(
        JSON.stringify({ allowed: true, reason: '' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get AI prompt from site_settings
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    const { data: promptData } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', 'chatbox_ai_prompt')
      .maybeSingle();

    const systemPrompt = promptData?.value || `You are a chat moderation assistant. Analyze messages and detect personal contact information sharing attempts. If violation detected respond with {"allowed": false, "reason": "..."}, otherwise respond with {"allowed": true, "reason": ""}. Always respond in valid JSON only.`;

    console.log('Moderating message:', message.substring(0, 100));

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this message: "${message}"` }
        ],
        max_tokens: 200,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', response.status, errorText);
      // If API fails, allow message (fail-open for user experience)
      return new Response(
        JSON.stringify({ allowed: true, reason: '' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    const aiResponse = data.choices?.[0]?.message?.content || '';
    
    console.log('AI Response:', aiResponse);

    // Parse AI response
    try {
      // Clean up response - remove markdown code blocks if present
      let cleanResponse = aiResponse.trim();
      if (cleanResponse.startsWith('```json')) {
        cleanResponse = cleanResponse.replace(/```json\n?/, '').replace(/\n?```$/, '');
      } else if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/```\n?/, '').replace(/\n?```$/, '');
      }
      
      const result = JSON.parse(cleanResponse);
      
      return new Response(
        JSON.stringify({
          allowed: result.allowed !== false,
          reason: result.reason || ''
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError);
      // If parsing fails, allow message
      return new Response(
        JSON.stringify({ allowed: true, reason: '' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

  } catch (error) {
    console.error('Error in moderate-chat-message:', error);
    // Fail-open: allow message if there's an error
    return new Response(
      JSON.stringify({ allowed: true, reason: '' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
