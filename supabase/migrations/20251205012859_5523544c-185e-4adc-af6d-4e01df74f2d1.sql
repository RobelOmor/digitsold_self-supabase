
-- 1. Create app_role enum
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');

-- 2. Create user_roles table
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- 3. Security definer function for role checking
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- 4. Update profiles table - add balance and status
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT false;

-- 5. Categories table
CREATE TABLE public.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

-- 6. Subcategories table
CREATE TABLE public.subcategories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID REFERENCES public.categories(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(category_id, slug)
);
ALTER TABLE public.subcategories ENABLE ROW LEVEL SECURITY;

-- 7. Products table
CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subcategory_id UUID REFERENCES public.subcategories(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  image_url TEXT,
  country TEXT,
  server_status TEXT NOT NULL DEFAULT 'online',
  replacement_hours INT DEFAULT 0,
  risk_warning TEXT,
  min_quantity INT NOT NULL DEFAULT 1,
  max_quantity INT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

-- 8. Product Stock table (CRITICAL - holds account data)
CREATE TABLE public.product_stock (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE NOT NULL,
  account_data TEXT NOT NULL,
  status INT NOT NULL DEFAULT 1, -- 1=available, 2=sold
  order_id UUID,
  sold_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.product_stock ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_product_stock_status ON public.product_stock(product_id, status);

-- 9. Orders table
CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL NOT NULL,
  batch_id TEXT NOT NULL UNIQUE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  quantity INT NOT NULL,
  price_per_item DECIMAL(10,2) NOT NULL,
  total_price DECIMAL(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  replacement_deadline TIMESTAMPTZ,
  download_count INT NOT NULL DEFAULT 0,
  max_downloads INT NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- 10. Deposits table
CREATE TABLE public.deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  method TEXT NOT NULL, -- crypto_usdt, crypto_btc, manual
  transaction_id TEXT,
  wallet_address TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  admin_note TEXT,
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.deposits ENABLE ROW LEVEL SECURITY;

-- 11. Balance logs table
CREATE TABLE public.balance_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  previous_balance DECIMAL(12,2) NOT NULL,
  change_amount DECIMAL(12,2) NOT NULL,
  new_balance DECIMAL(12,2) NOT NULL,
  type TEXT NOT NULL, -- deposit, purchase, refund, admin_adjust
  reference_id UUID,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.balance_logs ENABLE ROW LEVEL SECURITY;

-- 12. Support tickets table
CREATE TABLE public.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  issue_type TEXT NOT NULL, -- order_issue, replacement, payment, other
  status TEXT NOT NULL DEFAULT 'pending', -- pending, in_progress, solved, closed
  priority TEXT NOT NULL DEFAULT 'normal', -- low, normal, high, urgent
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

-- 13. Ticket messages table
CREATE TABLE public.ticket_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID REFERENCES public.support_tickets(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL NOT NULL,
  message TEXT NOT NULL,
  image_url TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  is_internal_note BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;

-- 14. Admin logs table
CREATE TABLE public.admin_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL, -- user, product, order, deposit, ticket
  target_id UUID,
  details JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_logs ENABLE ROW LEVEL SECURITY;

-- 15. Login logs table
CREATE TABLE public.login_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.login_logs ENABLE ROW LEVEL SECURITY;

-- 16. Notifications table
CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info', -- info, success, warning, error
  is_read BOOLEAN NOT NULL DEFAULT false,
  link TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- 17. Blacklist table
CREATE TABLE public.blacklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL, -- ip, email, country
  value TEXT NOT NULL,
  reason TEXT,
  created_by UUID REFERENCES auth.users(id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(type, value)
);
ALTER TABLE public.blacklist ENABLE ROW LEVEL SECURITY;

-- RLS POLICIES

-- User roles policies
CREATE POLICY "Users can view their own roles" ON public.user_roles
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Admins can manage all roles" ON public.user_roles
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Categories - public read, admin write
CREATE POLICY "Anyone can view active categories" ON public.categories
  FOR SELECT USING (is_active = true);
CREATE POLICY "Admins can manage categories" ON public.categories
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Subcategories - public read, admin write
CREATE POLICY "Anyone can view active subcategories" ON public.subcategories
  FOR SELECT USING (is_active = true);
CREATE POLICY "Admins can manage subcategories" ON public.subcategories
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Products - public read, admin write
CREATE POLICY "Anyone can view active products" ON public.products
  FOR SELECT USING (is_active = true);
CREATE POLICY "Admins can manage products" ON public.products
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Product stock - admin only (users access via function)
CREATE POLICY "Admins can manage stock" ON public.product_stock
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Orders - users see own, admins see all
CREATE POLICY "Users can view their own orders" ON public.orders
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Admins can view all orders" ON public.orders
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

-- Deposits - users see own, admins manage all
CREATE POLICY "Users can view their own deposits" ON public.deposits
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create deposits" ON public.deposits
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins can manage all deposits" ON public.deposits
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Balance logs - users see own, admins see all
CREATE POLICY "Users can view their own balance logs" ON public.balance_logs
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Admins can view all balance logs" ON public.balance_logs
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

-- Support tickets - users manage own, admins manage all
CREATE POLICY "Users can view their own tickets" ON public.support_tickets
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create tickets" ON public.support_tickets
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins can manage all tickets" ON public.support_tickets
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Ticket messages
CREATE POLICY "Users can view messages of their tickets" ON public.ticket_messages
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.support_tickets WHERE id = ticket_id AND user_id = auth.uid())
    OR public.has_role(auth.uid(), 'admin')
  );
CREATE POLICY "Users can add messages to their tickets" ON public.ticket_messages
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.support_tickets WHERE id = ticket_id AND user_id = auth.uid())
  );
CREATE POLICY "Admins can manage all messages" ON public.ticket_messages
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Admin logs - admin only
CREATE POLICY "Admins can view admin logs" ON public.admin_logs
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can create admin logs" ON public.admin_logs
  FOR INSERT WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Login logs - users see own, admins see all
CREATE POLICY "Users can view their own login logs" ON public.login_logs
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Admins can view all login logs" ON public.login_logs
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

-- Notifications - users see own
CREATE POLICY "Users can view their own notifications" ON public.notifications
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update their own notifications" ON public.notifications
  FOR UPDATE USING (auth.uid() = user_id);

-- Blacklist - admin only
CREATE POLICY "Admins can manage blacklist" ON public.blacklist
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- CRITICAL: Purchase function with row locking to prevent race conditions
CREATE OR REPLACE FUNCTION public.purchase_product(
  p_user_id UUID,
  p_product_id UUID,
  p_quantity INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product RECORD;
  v_user_balance DECIMAL(12,2);
  v_total_price DECIMAL(12,2);
  v_order_id UUID;
  v_batch_id TEXT;
  v_stock_ids UUID[];
  v_new_balance DECIMAL(12,2);
BEGIN
  -- Lock the user row to prevent concurrent purchases
  SELECT balance INTO v_user_balance
  FROM public.profiles
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'User not found');
  END IF;

  -- Get product info
  SELECT * INTO v_product
  FROM public.products
  WHERE id = p_product_id AND is_active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Product not found');
  END IF;

  -- Calculate total price
  v_total_price := v_product.price * p_quantity;

  -- Check balance
  IF v_user_balance < v_total_price THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance', 'required', v_total_price, 'available', v_user_balance);
  END IF;

  -- Lock and get available stock items
  SELECT ARRAY_AGG(id) INTO v_stock_ids
  FROM (
    SELECT id
    FROM public.product_stock
    WHERE product_id = p_product_id AND status = 1
    ORDER BY created_at
    LIMIT p_quantity
    FOR UPDATE SKIP LOCKED
  ) locked_rows;

  -- Check if we got enough stock
  IF v_stock_ids IS NULL OR array_length(v_stock_ids, 1) < p_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not enough stock available', 'requested', p_quantity, 'available', COALESCE(array_length(v_stock_ids, 1), 0));
  END IF;

  -- Generate batch ID
  v_batch_id := 'ORD' || to_char(now(), 'YYYYMMDD') || '#' || floor(random() * 900000 + 100000)::text;

  -- Create order
  INSERT INTO public.orders (user_id, batch_id, product_id, product_name, quantity, price_per_item, total_price, replacement_deadline)
  VALUES (p_user_id, v_batch_id, p_product_id, v_product.name, p_quantity, v_product.price, v_total_price, 
    CASE WHEN v_product.replacement_hours > 0 THEN now() + (v_product.replacement_hours || ' hours')::interval ELSE NULL END)
  RETURNING id INTO v_order_id;

  -- Update stock status
  UPDATE public.product_stock
  SET status = 2, order_id = v_order_id, sold_at = now()
  WHERE id = ANY(v_stock_ids);

  -- Deduct balance
  v_new_balance := v_user_balance - v_total_price;
  UPDATE public.profiles
  SET balance = v_new_balance
  WHERE user_id = p_user_id;

  -- Log balance change
  INSERT INTO public.balance_logs (user_id, previous_balance, change_amount, new_balance, type, reference_id, description)
  VALUES (p_user_id, v_user_balance, -v_total_price, v_new_balance, 'purchase', v_order_id, 'Purchase: ' || v_product.name || ' x' || p_quantity);

  -- Create notification
  INSERT INTO public.notifications (user_id, title, message, type, link)
  VALUES (p_user_id, 'Order Completed', 'Your order ' || v_batch_id || ' is ready for download!', 'success', '/orders/' || v_order_id::text);

  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'batch_id', v_batch_id,
    'quantity', p_quantity,
    'total_price', v_total_price,
    'new_balance', v_new_balance
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Function to get stock count for a product
CREATE OR REPLACE FUNCTION public.get_stock_count(p_product_id UUID)
RETURNS INT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::INT FROM public.product_stock WHERE product_id = p_product_id AND status = 1;
$$;

-- Function to get order items (account data) for download
CREATE OR REPLACE FUNCTION public.get_order_items(p_order_id UUID, p_user_id UUID)
RETURNS TABLE(account_data TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Verify order belongs to user
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = p_order_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'Order not found or access denied';
  END IF;

  -- Update download count
  UPDATE public.orders SET download_count = download_count + 1 WHERE id = p_order_id;

  RETURN QUERY
  SELECT ps.account_data
  FROM public.product_stock ps
  WHERE ps.order_id = p_order_id
  ORDER BY ps.sold_at;
END;
$$;

-- Trigger to auto-create user role on signup
CREATE OR REPLACE FUNCTION public.handle_new_user_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user');
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created_role
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_role();

-- Trigger to update updated_at
CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_subcategories_updated_at BEFORE UPDATE ON public.subcategories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_tickets_updated_at BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
