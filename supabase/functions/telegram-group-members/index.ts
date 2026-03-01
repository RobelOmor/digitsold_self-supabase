import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function normalizeBotToken(raw: string) {
  return (raw ?? '')
    .trim()
    .replace(/^https?:\/\/api\.telegram\.org\/bot/i, '')
    .replace(/^bot/i, '');
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const rawBotToken = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
    const botToken = normalizeBotToken(rawBotToken);
    const chatId = (Deno.env.get('TELEGRAM_GROUP_CHAT_ID') ?? '').trim();

    if (!botToken || !chatId) {
      console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_GROUP_CHAT_ID');
      return new Response(
        JSON.stringify({ success: false, error: 'Bot configuration missing' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body = await req.json().catch(() => ({} as any));
    const { action, userId, limit = 200, offset = 0, message } = body ?? {};

    let result;

    switch (action) {
      case 'getChat':
        // Get chat info
        const chatInfoRes = await fetch(
          `https://api.telegram.org/bot${botToken}/getChat?chat_id=${chatId}`
        );
        const chatInfo = await chatInfoRes.json();
        console.log('getChat response:', JSON.stringify(chatInfo));
        result = chatInfo;
        break;

      case 'getMemberCount':
        // Get member count
        const countRes = await fetch(
          `https://api.telegram.org/bot${botToken}/getChatMemberCount?chat_id=${chatId}`
        );
        const countData = await countRes.json();
        console.log('getMemberCount response:', JSON.stringify(countData));
        result = countData;
        break;

      case 'getAdmins':
        // Get admins
        const adminsRes = await fetch(
          `https://api.telegram.org/bot${botToken}/getChatAdministrators?chat_id=${chatId}`
        );
        const adminsData = await adminsRes.json();
        console.log('getAdmins response:', JSON.stringify(adminsData));
        result = adminsData;
        break;

      case 'getMember':
        // Get specific member
        if (!userId) {
          return new Response(
            JSON.stringify({ success: false, error: 'userId required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        const memberRes = await fetch(
          `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${chatId}&user_id=${userId}`
        );
        const memberData = await memberRes.json();
        console.log('getMember response:', JSON.stringify(memberData));
        result = memberData;
        break;

      case 'banMember':
        // Ban a member
        if (!userId) {
          return new Response(
            JSON.stringify({ success: false, error: 'userId required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        const banRes = await fetch(
          `https://api.telegram.org/bot${botToken}/banChatMember?chat_id=${chatId}&user_id=${userId}`
        );
        const banData = await banRes.json();
        console.log('banMember response:', JSON.stringify(banData));
        result = banData;
        break;

      case 'unbanMember':
        // Unban a member
        if (!userId) {
          return new Response(
            JSON.stringify({ success: false, error: 'userId required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        const unbanRes = await fetch(
          `https://api.telegram.org/bot${botToken}/unbanChatMember?chat_id=${chatId}&user_id=${userId}&only_if_banned=true`
        );
        const unbanData = await unbanRes.json();
        console.log('unbanMember response:', JSON.stringify(unbanData));
        result = unbanData;
        break;

      case 'sendMessage': {
        // Send message to group
        const text = typeof message === 'string' ? message : '';
        if (!text.trim()) {
          return new Response(
            JSON.stringify({ success: false, error: 'message required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        const msgRes = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              parse_mode: 'HTML'
            })
          }
        );
        const msgData = await msgRes.json();
        console.log('sendMessage response:', JSON.stringify(msgData));
        result = msgData;
        break;
      }

      case 'getFullInfo': {
        // Get all info at once
        const [chatRes, memberCountRes, adminListRes] = await Promise.all([
          fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${chatId}`),
          fetch(`https://api.telegram.org/bot${botToken}/getChatMemberCount?chat_id=${chatId}`),
          fetch(`https://api.telegram.org/bot${botToken}/getChatAdministrators?chat_id=${chatId}`)
        ]);

        const [chat, memberCount, adminList] = await Promise.all([
          chatRes.json(),
          memberCountRes.json(),
          adminListRes.json()
        ]);

        console.log('getFullInfo - chat:', JSON.stringify(chat));
        console.log('getFullInfo - memberCount:', JSON.stringify(memberCount));
        console.log('getFullInfo - adminList:', JSON.stringify(adminList));

        const errors: Array<{ scope: string; error_code?: number; description?: string }> = [];
        if (!chat?.ok) errors.push({ scope: 'getChat', error_code: chat?.error_code, description: chat?.description });
        if (!memberCount?.ok) errors.push({ scope: 'getChatMemberCount', error_code: memberCount?.error_code, description: memberCount?.description });
        if (!adminList?.ok) errors.push({ scope: 'getChatAdministrators', error_code: adminList?.error_code, description: adminList?.description });

        if (errors.length) {
          const tokenInvalid = errors.some((e) => e.error_code === 404);
          result = {
            ok: false,
            error_code: errors[0].error_code ?? 500,
            description: tokenInvalid
              ? 'Telegram Bot Token invalid (404 Not Found). Please update TELEGRAM_BOT_TOKEN from @BotFather (only the token, not the full URL).'
              : (errors[0].description || 'Telegram API error'),
            errors
          };
        } else {
          result = {
            ok: true,
            result: {
              chat: chat.result,
              memberCount: memberCount.result,
              admins: adminList.result
            }
          };
        }
        break;
      }

      default:
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid action' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in telegram-group-members function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
