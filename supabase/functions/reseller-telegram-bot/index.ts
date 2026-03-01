import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const resellerId = url.searchParams.get('reseller_id');
    
    if (!resellerId) {
      console.error('Missing reseller_id');
      return new Response(JSON.stringify({ error: 'Missing reseller_id' }), { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get reseller info
    const { data: reseller, error: resellerError } = await supabase
      .from('bot_resellers')
      .select('*')
      .eq('id', resellerId)
      .single();

    if (resellerError || !reseller) {
      console.error('Reseller not found:', resellerError);
      return new Response(JSON.stringify({ error: 'Reseller not found' }), { 
        status: 404, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    if (!reseller.is_active) {
      console.log('Reseller is inactive');
      return new Response(JSON.stringify({ ok: true }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    const botToken = reseller.bot_token;
    const update = await req.json();
    console.log('Received update:', JSON.stringify(update));

    const message = update.message || update.callback_query?.message;
    const callbackQuery = update.callback_query;
    const chatId = message?.chat?.id?.toString();
    const text = message?.text || '';
    // For callback queries, get sender from callbackQuery.from, not message.from
    const telegramUserId = callbackQuery ? callbackQuery.from?.id?.toString() : message?.from?.id?.toString();
    const username = callbackQuery ? callbackQuery.from?.username || '' : message?.from?.username || '';

    if (!chatId || !telegramUserId) {
      return new Response(JSON.stringify({ ok: true }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    // Check if this is the bot owner (reseller)
    // reseller.telegram_id can be either numeric Telegram user ID OR a username (with/without @)
    const resellerTelegram = normalizeTelegramHandle(reseller.telegram_id);
    const userTelegramId = normalizeTelegramHandle(telegramUserId);
    const userUsername = normalizeTelegramHandle(username);
    const userChatId = normalizeTelegramHandle(chatId);

    const isOwner =
      resellerTelegram.length > 0 &&
      (userTelegramId === resellerTelegram ||
        userUsername === resellerTelegram ||
        userChatId === resellerTelegram);

    console.log('Owner check:', {
      telegramUserId,
      username,
      resellerTelegramId: reseller.telegram_id,
      resellerTelegram,
      isOwner,
    });

    // Get or create user
    let { data: user } = await supabase
      .from('reseller_users')
      .select('*')
      .eq('telegram_id', telegramUserId)
      .eq('reseller_id', resellerId)
      .maybeSingle();

    if (!user) {
      const { data: newUser, error: createError } = await supabase
        .from('reseller_users')
        .insert({
          telegram_id: telegramUserId,
          telegram_username: username,
          reseller_id: resellerId,
          balance: 0
        })
        .select()
        .single();
      
      if (createError) {
        console.error('Error creating user:', createError);
      }
      user = newUser;
    }

    // Get payment settings
    const { data: paymentSettings } = await supabase
      .from('reseller_payment_settings')
      .select('*')
      .eq('reseller_id', resellerId)
      .maybeSingle();

    // Helper function to send message
    async function sendMessage(chatId: string, text: string, options?: { inline_keyboard?: any; reply_keyboard?: any; remove_keyboard?: boolean }) {
      const body: any = { chat_id: chatId, text, parse_mode: 'HTML' };
      
      if (options?.inline_keyboard) {
        body.reply_markup = { inline_keyboard: options.inline_keyboard };
      } else if (options?.reply_keyboard) {
        body.reply_markup = { 
          keyboard: options.reply_keyboard, 
          resize_keyboard: true,
          is_persistent: true
        };
      } else if (options?.remove_keyboard) {
        body.reply_markup = { remove_keyboard: true };
      }
      
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const result = await response.json();
      console.log('Send message result:', JSON.stringify(result));
      return result;
    }

    // Helper to send document
    async function sendDocument(chatId: string, content: string, filename: string, caption: string) {
      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('document', new Blob([content], { type: 'text/plain' }), filename);
      formData.append('caption', caption);
      
      await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
        method: 'POST',
        body: formData
      });
    }

    // Helper to answer callback query
    async function answerCallback(callbackQueryId: string, text?: string) {
      await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text })
      });
    }

    function normalizeTelegramHandle(v: string | null | undefined) {
      return (v ?? '').toString().trim().replace(/^@/, '').toLowerCase();
    }

    const MIN_DEPOSIT_USD = 5;

    async function getSiteSettings(keys: string[]): Promise<Record<string, string>> {
      const { data, error } = await supabase
        .from('site_settings')
        .select('key, value')
        .in('key', keys);

      if (error) {
        console.error('Failed to read site settings:', error);
        return {};
      }

      const map: Record<string, string> = {};
      for (const row of data ?? []) {
        map[row.key] = row.value;
      }
      return map;
    }

    // Main menu keyboard
    const mainMenuKeyboard = [
      [{ text: '💰 Deposit' }, { text: '🛒 Buy Accounts' }],
      [{ text: '📋 Order History' }, { text: '💬 Support' }]
    ];

    // Owner panel keyboard
    const ownerMenuKeyboard = [
      [{ text: '💰 Deposit' }, { text: '🛒 Buy Accounts' }],
      [{ text: '📋 Order History' }, { text: '💬 Support' }],
      [{ text: '👑 Owner Panel' }]
    ];

    const getKeyboard = () => isOwner ? ownerMenuKeyboard : mainMenuKeyboard;

    // Handle callback queries
    if (callbackQuery) {
      const data = callbackQuery.data;
      await answerCallback(callbackQuery.id);

      // === CATEGORY SELECTION ===
      if (data === 'show_categories') {
        // Fetch categories with products
        const { data: categories } = await supabase
          .from('categories')
          .select('id, name, slug')
          .eq('is_active', true)
          .order('sort_order');

        if (!categories || categories.length === 0) {
          await sendMessage(chatId, '📦 <b>No categories available</b>', {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu' }]]
          });
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const categoryButtons = categories.map(c => 
          [{ text: c.name, callback_data: `cat_${c.id}` }]
        );
        categoryButtons.push([{ text: '🔙 Back', callback_data: 'menu' }]);

        await sendMessage(chatId, '📂 <b>Select Category</b>\n\nChoose a category to browse products:', {
          inline_keyboard: categoryButtons
        });
      }
      // === SHOW PRODUCTS IN CATEGORY ===
      else if (data.startsWith('cat_')) {
        const categoryId = data.replace('cat_', '');
        
        // Get category name
        const { data: category } = await supabase
          .from('categories')
          .select('name')
          .eq('id', categoryId)
          .single();

        // Fetch products in this category
        const { data: products } = await supabase
          .from('seller_products')
          .select(`
            id, name, price, description,
            subcategory:subcategories!inner(category_id)
          `)
          .eq('is_active', true)
          .eq('subcategory.category_id', categoryId);

        if (!products || products.length === 0) {
          await sendMessage(chatId, `📦 <b>No products in ${category?.name || 'this category'}</b>`, {
            inline_keyboard: [[{ text: '🔙 Back to Categories', callback_data: 'show_categories' }]]
          });
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Get stock for each product
        const productsWithStock = [];
        for (const product of products) {
          const { count } = await supabase
            .from('seller_product_stock')
            .select('*', { count: 'exact', head: true })
            .eq('product_id', product.id)
            .eq('status', 1);
          
          if (count && count > 0) {
            productsWithStock.push({ ...product, stock: count });
          }
        }

        if (productsWithStock.length === 0) {
          await sendMessage(chatId, `📦 <b>No stock available in ${category?.name || 'this category'}</b>`, {
            inline_keyboard: [[{ text: '🔙 Back to Categories', callback_data: 'show_categories' }]]
          });
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const productButtons = productsWithStock.map(p => 
          [{ text: `${p.name} (${p.stock} available)`, callback_data: `prod_${p.id}` }]
        );
        productButtons.push([{ text: '🔙 Back to Categories', callback_data: 'show_categories' }]);

        await sendMessage(chatId, `📂 <b>${category?.name || 'Products'}</b>\n\nSelect a product:`, {
          inline_keyboard: productButtons
        });
      }
      // === PRODUCT DETAIL ===
      else if (data.startsWith('prod_')) {
        const productId = data.replace('prod_', '');
        
        const { data: product } = await supabase
          .from('seller_products')
          .select('*, subcategory:subcategories(name, category_id)')
          .eq('id', productId)
          .single();

        if (!product) {
          await sendMessage(chatId, '❌ Product not found', {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'show_categories' }]]
          });
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Get stock count
        const { count: stockCount } = await supabase
          .from('seller_product_stock')
          .select('*', { count: 'exact', head: true })
          .eq('product_id', productId)
          .eq('status', 1);

        const productText = `🛍️ <b>${product.name}</b>\n\n${product.description ? `📝 ${product.description}\n\n` : ''}💰 Price: $${product.price}\n📦 Available: ${stockCount || 0}`;

        await sendMessage(chatId, productText, {
          inline_keyboard: [
            [{ text: '🛒 Buy Now', callback_data: `buy_${productId}` }],
            [{ text: '🔙 Back', callback_data: `cat_${product.subcategory?.category_id}` }]
          ]
        });
      }
      // === BUY - ASK QUANTITY ===
      else if (data.startsWith('buy_')) {
        const productId = data.replace('buy_', '');
        
        const { data: product } = await supabase
          .from('seller_products')
          .select('*')
          .eq('id', productId)
          .single();

        if (!product) {
          await sendMessage(chatId, '❌ Product not found');
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Get stock count
        const { count: stockCount } = await supabase
          .from('seller_product_stock')
          .select('*', { count: 'exact', head: true })
          .eq('product_id', productId)
          .eq('status', 1);

        if (!stockCount || stockCount === 0) {
          await sendMessage(chatId, '❌ Out of stock!', {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'show_categories' }]]
          });
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Store pending purchase state
        await supabase
          .from('reseller_users')
          .update({ 
            pending_bkash_number: `pending_buy:${productId}` // Using this field temporarily for state
          })
          .eq('id', user?.id);

        await sendMessage(chatId, `🛒 <b>Buy ${product.name}</b>\n\n💰 Price: $${product.price} each\n📦 Available: ${stockCount}\n💵 Your Balance: $${Number(user?.balance || 0).toFixed(2)}\n\n<b>How many do you want to buy?</b>\n\nType a number (1-${Math.min(stockCount, 100)}):\n\nType /cancel to cancel.`);
      }
      // === ORDER PREVIEW ===
      else if (data.startsWith('preview_')) {
        const [_, productId, quantity] = data.split('_');
        const qty = parseInt(quantity);
        
        const { data: product } = await supabase
          .from('seller_products')
          .select('*')
          .eq('id', productId)
          .single();

        if (!product) {
          await sendMessage(chatId, '❌ Product not found');
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const totalPrice = qty * Number(product.price);

        await sendMessage(chatId, `📋 <b>Order Preview</b>\n\n📦 Product: ${product.name}\n🔢 Quantity: ${qty}\n💰 Price: $${product.price} × ${qty} = $${totalPrice.toFixed(2)}\n💵 Your Balance: $${Number(user?.balance || 0).toFixed(2)}\n\n${Number(user?.balance || 0) >= totalPrice ? '✅ You have enough balance!' : '❌ Insufficient balance!'}`, {
          inline_keyboard: Number(user?.balance || 0) >= totalPrice ? [
            [{ text: '✅ Confirm Purchase', callback_data: `confirm_${productId}_${qty}` }],
            [{ text: '❌ Cancel', callback_data: 'show_categories' }]
          ] : [
            [{ text: '💳 Deposit Now', callback_data: 'deposit_info' }],
            [{ text: '❌ Cancel', callback_data: 'show_categories' }]
          ]
        });
      }
      // === CONFIRM PURCHASE ===
      else if (data.startsWith('confirm_')) {
        const parts = data.split('_');
        const productId = parts[1];
        const qty = parseInt(parts[2]);
        
        const { data: product } = await supabase
          .from('seller_products')
          .select('*')
          .eq('id', productId)
          .single();

        if (!product) {
          await sendMessage(chatId, '❌ Product not found');
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const totalPrice = qty * Number(product.price);

        // Re-check balance
        if (Number(user?.balance || 0) < totalPrice) {
          await sendMessage(chatId, '❌ Insufficient balance', {
            inline_keyboard: [[{ text: '💳 Deposit', callback_data: 'deposit_info' }]]
          });
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Get available stock
        const { data: stockItems } = await supabase
          .from('seller_product_stock')
          .select('*')
          .eq('product_id', productId)
          .eq('status', 1)
          .order('created_at', { ascending: true })
          .limit(qty);

        if (!stockItems || stockItems.length < qty) {
          await sendMessage(chatId, `❌ Not enough stock! Only ${stockItems?.length || 0} available.`, {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'show_categories' }]]
          });
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Calculate reseller profit
        const resellerProfit = totalPrice * (Number(reseller.profit_percentage) / 100);

        // Create transaction record
        const { data: transaction } = await supabase
          .from('reseller_transactions')
          .insert({
            reseller_user_id: user?.id,
            reseller_id: resellerId,
            type: 'purchase',
            status: 'completed',
            amount: totalPrice,
            product_id: productId,
            product_name: product.name,
            quantity: qty,
            reseller_profit: resellerProfit
          })
          .select()
          .single();

        // Copy stock to reseller_product_stock (for order tracking)
        const stockData = stockItems.map(s => ({
          reseller_id: resellerId,
          product_id: productId,
          account_data: s.account_data,
          is_sold: true,
          sold_at: new Date().toISOString(),
          sold_to: user?.id,
          transaction_id: transaction?.id
        }));

        await supabase.from('reseller_product_stock').insert(stockData);

        // Mark original stock as sold
        const stockIds = stockItems.map(s => s.id);
        await supabase
          .from('seller_product_stock')
          .update({ status: 2, sold_at: new Date().toISOString() })
          .in('id', stockIds);

        // Deduct user balance
        const newBalance = Number(user?.balance || 0) - totalPrice;
        await supabase
          .from('reseller_users')
          .update({ balance: newBalance, pending_bkash_number: null })
          .eq('id', user?.id);

        // Update reseller earnings
        await supabase
          .from('bot_resellers')
          .update({ 
            pending_earnings: Number(reseller.pending_earnings) + resellerProfit 
          })
          .eq('id', resellerId);

        // Send success message with account data
        const accountDataText = stockItems.map((s, i) => `${i + 1}. <code>${s.account_data}</code>`).join('\n');
        
        await sendMessage(chatId, `✅ <b>Purchase Successful!</b>\n\n📦 Product: ${product.name}\n🔢 Quantity: ${qty}\n💰 Paid: $${totalPrice.toFixed(2)}\n💵 New Balance: $${newBalance.toFixed(2)}\n\n📋 <b>Your Accounts:</b>\n${accountDataText}`, {
          inline_keyboard: [
            [{ text: '📥 Download TXT', callback_data: `dl_txt_${transaction?.id}` }],
            [{ text: '📥 Download CSV', callback_data: `dl_csv_${transaction?.id}` }],
            [{ text: '🏠 Main Menu', callback_data: 'menu' }]
          ]
        });
      }
      // === DOWNLOAD TXT ===
      else if (data.startsWith('dl_txt_')) {
        const transactionId = data.replace('dl_txt_', '');
        
        const { data: stocks } = await supabase
          .from('reseller_product_stock')
          .select('account_data, product_id')
          .eq('transaction_id', transactionId)
          .eq('sold_to', user?.id);

        if (!stocks || stocks.length === 0) {
          await sendMessage(chatId, '❌ No data found for this order');
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const content = stocks.map(s => s.account_data).join('\n');
        await sendDocument(chatId, content, `order_${transactionId.slice(0, 8)}.txt`, '📄 Your order data');
      }
      // === DOWNLOAD CSV ===
      else if (data.startsWith('dl_csv_')) {
        const transactionId = data.replace('dl_csv_', '');
        
        const { data: stocks } = await supabase
          .from('reseller_product_stock')
          .select('account_data')
          .eq('transaction_id', transactionId)
          .eq('sold_to', user?.id);

        if (!stocks || stocks.length === 0) {
          await sendMessage(chatId, '❌ No data found for this order');
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const content = 'Account Data\n' + stocks.map(s => `"${s.account_data}"`).join('\n');
        await sendDocument(chatId, content, `order_${transactionId.slice(0, 8)}.csv`, '📄 Your order data (CSV)');
      }
      // === ORDER HISTORY ===
      else if (data === 'order_history') {
        const { data: orders } = await supabase
          .from('reseller_transactions')
          .select('*')
          .eq('reseller_user_id', user?.id)
          .eq('type', 'purchase')
          .eq('status', 'completed')
          .order('created_at', { ascending: false })
          .limit(10);

        if (!orders || orders.length === 0) {
          await sendMessage(chatId, '📋 <b>No orders yet</b>\n\nYour purchase history will appear here.', {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu' }]]
          });
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const orderButtons = orders.map(o => {
          const date = new Date(o.created_at).toLocaleDateString('en-GB');
          return [{ 
            text: `${o.product_name} x${o.quantity || 1} - $${o.amount} (${date})`, 
            callback_data: `order_${o.id}` 
          }];
        });
        orderButtons.push([{ text: '🔙 Back', callback_data: 'menu' }]);

        await sendMessage(chatId, '📋 <b>Order History</b>\n\nTap an order to view/download:', {
          inline_keyboard: orderButtons
        });
      }
      // === ORDER DETAIL ===
      else if (data.startsWith('order_') && !data.startsWith('order_history')) {
        const orderId = data.replace('order_', '');
        
        const { data: order } = await supabase
          .from('reseller_transactions')
          .select('*')
          .eq('id', orderId)
          .single();

        if (!order) {
          await sendMessage(chatId, '❌ Order not found');
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const date = new Date(order.created_at).toLocaleString('en-GB');

        await sendMessage(chatId, `📦 <b>Order Details</b>\n\n🛍️ Product: ${order.product_name}\n🔢 Quantity: ${order.quantity || 1}\n💰 Amount: $${order.amount}\n📅 Date: ${date}`, {
          inline_keyboard: [
            [{ text: '📥 Download TXT', callback_data: `dl_txt_${orderId}` }],
            [{ text: '📥 Download CSV', callback_data: `dl_csv_${orderId}` }],
            [{ text: '🔙 Back to Orders', callback_data: 'order_history' }]
          ]
        });
      }
      // === OWNER PANEL ===
      else if (data === 'owner_panel') {
        const pendingEarnings = Number(reseller.pending_earnings || 0);
        const totalEarnings = Number(reseller.total_earnings || 0);
        
        await sendMessage(chatId, `👑 <b>Owner Panel</b>\n\n💰 Pending Earnings: $${pendingEarnings.toFixed(2)}\n✅ Total Withdrawn: $${totalEarnings.toFixed(2)}`, {
          inline_keyboard: [
            [{ text: '📊 Sale History', callback_data: 'owner_sales' }],
            [{ text: '💸 Withdraw', callback_data: 'owner_withdraw' }],
            [{ text: '📈 Stats', callback_data: 'owner_stats' }],
            [{ text: '🔙 Main Menu', callback_data: 'menu' }]
          ]
        });
      }
      // === OWNER SALE HISTORY ===
      else if (data === 'owner_sales') {
        const { data: sales } = await supabase
          .from('reseller_transactions')
          .select('*')
          .eq('reseller_id', resellerId)
          .eq('type', 'purchase')
          .eq('status', 'completed')
          .order('created_at', { ascending: false })
          .limit(20);

        if (!sales || sales.length === 0) {
          await sendMessage(chatId, '📊 <b>No sales yet</b>', {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'owner_panel' }]]
          });
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        let salesText = '📊 <b>Recent Sales</b>\n\n';
        for (const sale of sales) {
          const date = new Date(sale.created_at).toLocaleDateString('en-GB');
          salesText += `📦 ${sale.product_name} x${sale.quantity || 1}\n💰 $${sale.amount} | Profit: $${Number(sale.reseller_profit || 0).toFixed(2)}\n📅 ${date}\n\n`;
        }

        await sendMessage(chatId, salesText, {
          inline_keyboard: [[{ text: '🔙 Back', callback_data: 'owner_panel' }]]
        });
      }
      // === OWNER WITHDRAW ===
      else if (data === 'owner_withdraw') {
        const pendingEarnings = Number(reseller.pending_earnings || 0);
        const minWithdraw = paymentSettings?.min_withdraw || 500;
        
        if (pendingEarnings < minWithdraw) {
          await sendMessage(chatId, `❌ <b>Minimum Withdrawal Not Met</b>\n\nYou need at least $${minWithdraw} to withdraw.\nYour pending: $${pendingEarnings.toFixed(2)}`, {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'owner_panel' }]]
          });
        } else {
          await supabase
            .from('reseller_users')
            .update({ in_withdraw_mode: true })
            .eq('id', user?.id);
          
          await sendMessage(chatId, `💸 <b>Withdraw Earnings</b>\n\n💰 Available: $${pendingEarnings.toFixed(2)}\n\nSend your bKash number:\n\n<i>Example: 01712345678</i>\n\nType /cancel to cancel.`);
        }
      }
      // === OWNER STATS ===
      else if (data === 'owner_stats') {
        const { count: totalUsers } = await supabase
          .from('reseller_users')
          .select('*', { count: 'exact', head: true })
          .eq('reseller_id', resellerId);

        const { count: totalSales } = await supabase
          .from('reseller_transactions')
          .select('*', { count: 'exact', head: true })
          .eq('reseller_id', resellerId)
          .eq('type', 'purchase')
          .eq('status', 'completed');

        const { data: salesData } = await supabase
          .from('reseller_transactions')
          .select('amount, reseller_profit')
          .eq('reseller_id', resellerId)
          .eq('type', 'purchase')
          .eq('status', 'completed');

        const totalRevenue = salesData?.reduce((sum, t) => sum + Number(t.amount), 0) || 0;
        const totalProfit = salesData?.reduce((sum, t) => sum + Number(t.reseller_profit || 0), 0) || 0;

        await sendMessage(chatId, `📊 <b>Bot Statistics</b>\n\n👥 Total Users: ${totalUsers || 0}\n🛒 Total Sales: ${totalSales || 0}\n💰 Total Revenue: $${totalRevenue.toFixed(2)}\n💵 Total Profit: $${totalProfit.toFixed(2)}\n📈 Profit Rate: ${reseller.profit_percentage}%`, {
          inline_keyboard: [[{ text: '🔙 Back', callback_data: 'owner_panel' }]]
        });
      }
      // === MENU ===
      else if (data === 'menu') {
        await sendMessage(chatId, `🏠 <b>Main Menu</b>\n\n💵 Balance: $${Number(user?.balance || 0).toFixed(2)}\n\nUse the buttons below:`, {
          reply_keyboard: getKeyboard()
        });
      }
      // === DEPOSIT (ADMIN CONFIG - USDT) ===
      else if (data === 'deposit_info') {
        await sendMessage(chatId, `💳 <b>Deposit (USDT)</b>\n\nMinimum deposit: $${MIN_DEPOSIT_USD}\n\nSelect network:`, {
          inline_keyboard: [
            [
              { text: 'USDT • BEP20', callback_data: 'dep_usdt_bep20' },
              { text: 'USDT • TRC20', callback_data: 'dep_usdt_trc20' }
            ],
            [{ text: '🔙 Back', callback_data: 'menu' }]
          ]
        });
      }
      else if (data === 'dep_usdt_bep20' || data === 'dep_usdt_trc20') {
        const network = data === 'dep_usdt_bep20' ? 'BEP20' : 'TRC20';
        const settings = await getSiteSettings([
          'deposit_usdt_bep20_address',
          'deposit_usdt_trc20_address',
          'deposit_usdt_instructions'
        ]);

        const address =
          network === 'BEP20'
            ? settings['deposit_usdt_bep20_address']
            : settings['deposit_usdt_trc20_address'];

        if (!address) {
          await sendMessage(chatId, `❌ <b>Deposit address not set</b>\n\nAdmin has not configured the USDT ${network} address yet. Please contact support.`, {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'deposit_info' }]]
          });
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Store chosen network for /deposit submission
        await supabase
          .from('reseller_users')
          .update({ pending_bkash_number: `pending_deposit:usdt_${network.toLowerCase()}` })
          .eq('id', user?.id);

        const instructions =
          settings['deposit_usdt_instructions']?.trim() ||
          'After sending USDT, submit: <code>/deposit [amount] [txn_id]</code>';

        await sendMessage(
          chatId,
          `💳 <b>Deposit USDT (${network})</b>\n\nMinimum: $${MIN_DEPOSIT_USD}\n\nAddress:\n<code>${address}</code>\n\n${instructions}\n\nExample:\n<code>/deposit 10 TXN123456</code>`,
          {
            inline_keyboard: [
              [{ text: '🔁 Change Network', callback_data: 'deposit_info' }],
              [{ text: '🏠 Main Menu', callback_data: 'menu' }]
            ]
          }
        );
      }
    }
    // === TEXT MESSAGE HANDLERS ===
    else if (text) {
      // Check if user is entering quantity for purchase
      if (user?.pending_bkash_number?.startsWith('pending_buy:')) {
        const productId = user.pending_bkash_number.replace('pending_buy:', '');
        const quantity = parseInt(text);

        if (text === '/cancel') {
          await supabase.from('reseller_users').update({ pending_bkash_number: null }).eq('id', user?.id);
          await sendMessage(chatId, '✅ Purchase cancelled', { reply_keyboard: getKeyboard() });
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        if (isNaN(quantity) || quantity < 1) {
          await sendMessage(chatId, '❌ Please enter a valid number (1 or more)\n\nType /cancel to cancel.');
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Get product and check stock
        const { data: product } = await supabase
          .from('seller_products')
          .select('*')
          .eq('id', productId)
          .single();

        const { count: stockCount } = await supabase
          .from('seller_product_stock')
          .select('*', { count: 'exact', head: true })
          .eq('product_id', productId)
          .eq('status', 1);

        if (!stockCount || quantity > stockCount) {
          await sendMessage(chatId, `❌ Only ${stockCount || 0} available. Please enter a smaller quantity.`);
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Clear pending state
        await supabase.from('reseller_users').update({ pending_bkash_number: null }).eq('id', user?.id);

        // Show order preview
        const totalPrice = quantity * Number(product?.price || 0);

        await sendMessage(chatId, `📋 <b>Order Preview</b>\n\n📦 Product: ${product?.name}\n🔢 Quantity: ${quantity}\n💰 Total: $${totalPrice.toFixed(2)}\n💵 Your Balance: $${Number(user?.balance || 0).toFixed(2)}\n\n${Number(user?.balance || 0) >= totalPrice ? '✅ Sufficient balance' : '❌ Insufficient balance!'}`, {
          inline_keyboard: Number(user?.balance || 0) >= totalPrice ? [
            [{ text: '✅ Confirm Purchase', callback_data: `confirm_${productId}_${quantity}` }],
            [{ text: '❌ Cancel', callback_data: 'show_categories' }]
          ] : [
            [{ text: '💳 Deposit Now', callback_data: 'deposit_info' }],
            [{ text: '❌ Cancel', callback_data: 'show_categories' }]
          ]
        });
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // Reply keyboard handlers
      if (text === '💰 Deposit') {
        await sendMessage(chatId, `💳 <b>Deposit (USDT)</b>\n\nMinimum deposit: $${MIN_DEPOSIT_USD}\n\nSelect network:`, {
          inline_keyboard: [
            [
              { text: 'USDT • BEP20', callback_data: 'dep_usdt_bep20' },
              { text: 'USDT • TRC20', callback_data: 'dep_usdt_trc20' }
            ],
            [{ text: '🏠 Main Menu', callback_data: 'menu' }]
          ]
        });
      }
      else if (text === '🛒 Buy Accounts') {
        // Show categories
        const { data: categories } = await supabase
          .from('categories')
          .select('id, name')
          .eq('is_active', true)
          .order('sort_order');

        if (!categories || categories.length === 0) {
          await sendMessage(chatId, '📦 <b>No products available</b>', { reply_keyboard: getKeyboard() });
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const categoryButtons = categories.map(c => 
          [{ text: c.name, callback_data: `cat_${c.id}` }]
        );

        await sendMessage(chatId, '📂 <b>Select Category</b>\n\nChoose a category to browse products:', {
          inline_keyboard: categoryButtons
        });
      }
      else if (text === '📋 Order History') {
        const { data: orders } = await supabase
          .from('reseller_transactions')
          .select('*')
          .eq('reseller_user_id', user?.id)
          .eq('type', 'purchase')
          .eq('status', 'completed')
          .order('created_at', { ascending: false })
          .limit(10);

        if (!orders || orders.length === 0) {
          await sendMessage(chatId, '📋 <b>No orders yet</b>\n\nYour purchase history will appear here.', { reply_keyboard: getKeyboard() });
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const orderButtons = orders.map(o => {
          const date = new Date(o.created_at).toLocaleDateString('en-GB');
          return [{ 
            text: `${o.product_name} x${o.quantity || 1} - $${o.amount} (${date})`, 
            callback_data: `order_${o.id}` 
          }];
        });

        await sendMessage(chatId, '📋 <b>Order History</b>\n\nTap an order to view/download:', {
          inline_keyboard: orderButtons
        });
      }
      else if (text === '💬 Support') {
        await supabase
          .from('reseller_users')
          .update({ in_support_mode: true })
          .eq('id', user?.id);

        await sendMessage(chatId, '💬 <b>Support Mode</b>\n\nSend your message and we will reply soon.\n\nType /exit to leave support mode.');
      }
      else if (text === '👑 Owner Panel' && isOwner) {
        const pendingEarnings = Number(reseller.pending_earnings || 0);
        const totalEarnings = Number(reseller.total_earnings || 0);
        
        await sendMessage(chatId, `👑 <b>Owner Panel</b>\n\n💰 Pending Earnings: $${pendingEarnings.toFixed(2)}\n✅ Total Withdrawn: $${totalEarnings.toFixed(2)}`, {
          inline_keyboard: [
            [{ text: '📊 Sale History', callback_data: 'owner_sales' }],
            [{ text: '💸 Withdraw', callback_data: 'owner_withdraw' }],
            [{ text: '📈 Stats', callback_data: 'owner_stats' }],
            [{ text: '🔙 Main Menu', callback_data: 'menu' }]
          ]
        });
      }
      else if (text === '/start') {
        await sendMessage(chatId, `👋 <b>Welcome${isOwner ? ' Owner' : ''}!</b>\n\n💵 Your Balance: $${Number(user?.balance || 0).toFixed(2)}\n\nUse the menu buttons below:`, {
          reply_keyboard: getKeyboard()
        });
      }
      else if (text.startsWith('/deposit')) {
        const parts = text.trim().split(/\s+/);

        if (parts.length >= 3) {
          const amount = parseFloat(parts[1]);
          const txnId = parts[2];

          const pending = user?.pending_bkash_number || '';
          const network = pending.startsWith('pending_deposit:')
            ? pending.replace('pending_deposit:', '')
            : null;

          if (!network) {
            await sendMessage(
              chatId,
              '❌ Please select a deposit network first. Tap 💰 Deposit and choose BEP20 or TRC20.',
              { reply_keyboard: getKeyboard() }
            );
            return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }

          if (isNaN(amount) || amount < MIN_DEPOSIT_USD) {
            await sendMessage(chatId, `❌ Invalid amount. Minimum: $${MIN_DEPOSIT_USD}`, { reply_keyboard: getKeyboard() });
            return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }

          await supabase.from('reseller_transactions').insert({
            reseller_user_id: user?.id,
            reseller_id: resellerId,
            type: 'deposit',
            status: 'pending',
            amount,
            payment_method: network,
            transaction_ref: txnId,
            notes: `USDT deposit (${network}) from ${username || telegramUserId}`
          });

          await supabase
            .from('reseller_users')
            .update({ pending_bkash_number: null })
            .eq('id', user?.id);

          await sendMessage(
            chatId,
            `✅ <b>Deposit Request Submitted</b>\n\nNetwork: ${network.replace('usdt_', '').toUpperCase()}\nAmount: $${amount}\nTxn ID: ${txnId}\n\nWe will verify within 24 hours.`,
            { reply_keyboard: getKeyboard() }
          );
        } else {
          await sendMessage(chatId, '❌ Usage: /deposit [amount] [txn_id]\nExample: /deposit 10 TXN123456', { reply_keyboard: getKeyboard() });
        }
      }
      else if (text === '/cancel') {
        await supabase
          .from('reseller_users')
          .update({ in_support_mode: false, in_withdraw_mode: false, pending_bkash_number: null })
          .eq('id', user?.id);
        await sendMessage(chatId, '✅ Cancelled', { reply_keyboard: getKeyboard() });
      }
      else if (text === '/exit') {
        await supabase
          .from('reseller_users')
          .update({ in_support_mode: false, in_withdraw_mode: false })
          .eq('id', user?.id);
        await sendMessage(chatId, '✅ Exited', { reply_keyboard: getKeyboard() });
      }
      // Owner withdraw mode
      else if (user?.in_withdraw_mode && isOwner) {
        const bkashRegex = /^01[0-9]{9}$/;
        if (!bkashRegex.test(text)) {
          await sendMessage(chatId, '❌ Invalid bKash number. Enter 11 digits starting with 01.\n\nType /cancel to cancel.');
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const pendingEarnings = Number(reseller.pending_earnings || 0);
        
        if (pendingEarnings <= 0) {
          await sendMessage(chatId, '❌ No pending earnings.', { reply_keyboard: getKeyboard() });
          await supabase.from('reseller_users').update({ in_withdraw_mode: false }).eq('id', user?.id);
          return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        await supabase.from('reseller_transactions').insert({
          reseller_id: resellerId,
          type: 'withdrawal',
          status: 'pending',
          amount: pendingEarnings,
          payment_method: 'bkash',
          notes: `Withdrawal to bKash: ${text}`
        });

        await supabase
          .from('reseller_users')
          .update({ in_withdraw_mode: false, pending_bkash_number: text })
          .eq('id', user?.id);

        await supabase
          .from('bot_resellers')
          .update({ pending_earnings: 0 })
          .eq('id', resellerId);

        await sendMessage(chatId, `✅ <b>Withdrawal Request Submitted</b>\n\n💰 Amount: $${pendingEarnings.toFixed(2)}\n📱 bKash: ${text}\n\nAdmin will process within 24-48 hours.`, { reply_keyboard: getKeyboard() });
      }
      // Support mode
      else if (user?.in_support_mode) {
        await supabase.from('reseller_support_messages').insert({
          reseller_user_id: user.id,
          reseller_id: resellerId,
          telegram_chat_id: chatId,
          message: text,
          is_from_admin: false
        });

        await sendMessage(chatId, '✅ Message sent. We will reply soon.\n\nType /exit to leave support.');
      }
      else {
        await sendMessage(chatId, '🤖 Use the menu buttons below:', { reply_keyboard: getKeyboard() });
      }
    }

    return new Response(JSON.stringify({ ok: true }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Bot error:', error);
    return new Response(JSON.stringify({ error: errorMessage }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
