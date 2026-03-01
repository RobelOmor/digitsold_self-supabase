-- Bot Resellers table (Reseller/Bot owners)
CREATE TABLE public.bot_resellers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  bot_token TEXT NOT NULL,
  bot_username TEXT,
  telegram_id TEXT NOT NULL,
  telegram_username TEXT,
  profit_percentage NUMERIC NOT NULL DEFAULT 10,
  total_earnings NUMERIC NOT NULL DEFAULT 0,
  pending_earnings NUMERIC NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Reseller Users (Telegram users who interact with bots)
CREATE TABLE public.reseller_users (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  telegram_username TEXT,
  balance NUMERIC NOT NULL DEFAULT 0,
  reseller_id UUID REFERENCES public.bot_resellers(id) ON DELETE CASCADE,
  in_support_mode BOOLEAN NOT NULL DEFAULT false,
  in_withdraw_mode BOOLEAN NOT NULL DEFAULT false,
  pending_bkash_number TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(telegram_id, reseller_id)
);

-- Reseller Transactions
CREATE TABLE public.reseller_transactions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  reseller_user_id UUID REFERENCES public.reseller_users(id) ON DELETE CASCADE,
  reseller_id UUID REFERENCES public.bot_resellers(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('deposit', 'purchase', 'withdraw')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  amount NUMERIC NOT NULL,
  quantity INTEGER DEFAULT 1,
  product_id UUID REFERENCES public.seller_products(id) ON DELETE SET NULL,
  product_name TEXT,
  reseller_profit NUMERIC DEFAULT 0,
  payment_method TEXT,
  transaction_ref TEXT,
  notes TEXT,
  processed_by UUID,
  processed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Reseller Payment Settings
CREATE TABLE public.reseller_payment_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  reseller_id UUID REFERENCES public.bot_resellers(id) ON DELETE CASCADE UNIQUE,
  binance_email TEXT,
  binance_pay_id TEXT,
  bkash_number TEXT,
  nagad_number TEXT,
  rocket_number TEXT,
  min_deposit NUMERIC DEFAULT 100,
  min_withdraw NUMERIC DEFAULT 100,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Reseller Support Messages
CREATE TABLE public.reseller_support_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  reseller_user_id UUID REFERENCES public.reseller_users(id) ON DELETE CASCADE,
  reseller_id UUID REFERENCES public.bot_resellers(id) ON DELETE CASCADE,
  telegram_chat_id TEXT NOT NULL,
  message TEXT NOT NULL,
  image_url TEXT,
  is_from_admin BOOLEAN NOT NULL DEFAULT false,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Reseller Product Stock (separate from seller_product_stock to avoid conflicts)
CREATE TABLE public.reseller_product_stock (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID REFERENCES public.seller_products(id) ON DELETE CASCADE,
  account_data TEXT NOT NULL,
  is_sold BOOLEAN NOT NULL DEFAULT false,
  sold_to UUID REFERENCES public.reseller_users(id) ON DELETE SET NULL,
  sold_at TIMESTAMP WITH TIME ZONE,
  transaction_id UUID REFERENCES public.reseller_transactions(id) ON DELETE SET NULL,
  reseller_id UUID REFERENCES public.bot_resellers(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.bot_resellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_product_stock ENABLE ROW LEVEL SECURITY;

-- RLS Policies for bot_resellers
CREATE POLICY "Admins can manage bot resellers"
ON public.bot_resellers FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS Policies for reseller_users
CREATE POLICY "Admins can manage reseller users"
ON public.reseller_users FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS Policies for reseller_transactions
CREATE POLICY "Admins can manage reseller transactions"
ON public.reseller_transactions FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS Policies for reseller_payment_settings
CREATE POLICY "Admins can manage reseller payment settings"
ON public.reseller_payment_settings FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS Policies for reseller_support_messages
CREATE POLICY "Admins can manage reseller support messages"
ON public.reseller_support_messages FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS Policies for reseller_product_stock
CREATE POLICY "Admins can manage reseller product stock"
ON public.reseller_product_stock FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- Create indexes for better performance
CREATE INDEX idx_reseller_users_telegram ON public.reseller_users(telegram_id);
CREATE INDEX idx_reseller_users_reseller ON public.reseller_users(reseller_id);
CREATE INDEX idx_reseller_transactions_reseller ON public.reseller_transactions(reseller_id);
CREATE INDEX idx_reseller_transactions_status ON public.reseller_transactions(status);
CREATE INDEX idx_reseller_support_unread ON public.reseller_support_messages(is_read, reseller_id);
CREATE INDEX idx_reseller_stock_product ON public.reseller_product_stock(product_id, is_sold);

-- Trigger for updated_at
CREATE TRIGGER update_bot_resellers_updated_at
BEFORE UPDATE ON public.bot_resellers
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_reseller_users_updated_at
BEFORE UPDATE ON public.reseller_users
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_reseller_payment_settings_updated_at
BEFORE UPDATE ON public.reseller_payment_settings
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();