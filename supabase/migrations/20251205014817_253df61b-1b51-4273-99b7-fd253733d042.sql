
-- Add 'seller' to app_role enum
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'seller';

-- Seller applications table
CREATE TABLE public.seller_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  store_name TEXT NOT NULL,
  description TEXT,
  telegram_contact TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  admin_note TEXT,
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.seller_applications ENABLE ROW LEVEL SECURITY;

-- Seller profiles (for approved sellers)
CREATE TABLE public.seller_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  store_name TEXT NOT NULL,
  description TEXT,
  telegram_contact TEXT,
  balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total_sales DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total_orders INT NOT NULL DEFAULT 0,
  commission_rate DECIMAL(5,2) NOT NULL DEFAULT 10.00, -- 10% commission
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.seller_profiles ENABLE ROW LEVEL SECURITY;

-- Seller products (products created by sellers)
CREATE TABLE public.seller_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID REFERENCES public.seller_profiles(id) ON DELETE CASCADE NOT NULL,
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
ALTER TABLE public.seller_products ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_seller_products_seller ON public.seller_products(seller_id);

-- Seller product stock
CREATE TABLE public.seller_product_stock (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES public.seller_products(id) ON DELETE CASCADE NOT NULL,
  account_data TEXT NOT NULL,
  status INT NOT NULL DEFAULT 1, -- 1=available, 2=sold
  order_id UUID,
  sold_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.seller_product_stock ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_seller_stock_status ON public.seller_product_stock(product_id, status);

-- Seller orders (when someone buys from seller)
CREATE TABLE public.seller_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id UUID REFERENCES auth.users(id) ON DELETE SET NULL NOT NULL,
  seller_id UUID REFERENCES public.seller_profiles(id) ON DELETE SET NULL NOT NULL,
  product_id UUID REFERENCES public.seller_products(id) ON DELETE SET NULL,
  batch_id TEXT NOT NULL UNIQUE,
  product_name TEXT NOT NULL,
  quantity INT NOT NULL,
  price_per_item DECIMAL(10,2) NOT NULL,
  total_price DECIMAL(12,2) NOT NULL,
  seller_earning DECIMAL(12,2) NOT NULL,
  commission_amount DECIMAL(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  replacement_deadline TIMESTAMPTZ,
  download_count INT NOT NULL DEFAULT 0,
  max_downloads INT NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.seller_orders ENABLE ROW LEVEL SECURITY;

-- Seller withdrawals
CREATE TABLE public.seller_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID REFERENCES public.seller_profiles(id) ON DELETE CASCADE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  method TEXT NOT NULL, -- usdt_trc20, btc
  wallet_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  admin_note TEXT,
  processed_by UUID REFERENCES auth.users(id),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.seller_withdrawals ENABLE ROW LEVEL SECURITY;

-- Seller balance logs
CREATE TABLE public.seller_balance_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID REFERENCES public.seller_profiles(id) ON DELETE CASCADE NOT NULL,
  previous_balance DECIMAL(12,2) NOT NULL,
  change_amount DECIMAL(12,2) NOT NULL,
  new_balance DECIMAL(12,2) NOT NULL,
  type TEXT NOT NULL, -- sale, withdrawal, refund, adjustment
  reference_id UUID,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.seller_balance_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies

-- Seller applications
CREATE POLICY "Users can view their own application" ON public.seller_applications
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create application" ON public.seller_applications
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins can manage applications" ON public.seller_applications
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Seller profiles
CREATE POLICY "Anyone can view active seller profiles" ON public.seller_profiles
  FOR SELECT USING (is_active = true);
CREATE POLICY "Sellers can update own profile" ON public.seller_profiles
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Admins can manage seller profiles" ON public.seller_profiles
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Seller products
CREATE POLICY "Anyone can view active seller products" ON public.seller_products
  FOR SELECT USING (is_active = true);
CREATE POLICY "Sellers can manage own products" ON public.seller_products
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.seller_profiles WHERE id = seller_id AND user_id = auth.uid())
  );
CREATE POLICY "Admins can manage all seller products" ON public.seller_products
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Seller product stock
CREATE POLICY "Sellers can manage own stock" ON public.seller_product_stock
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.seller_products sp
      JOIN public.seller_profiles sel ON sp.seller_id = sel.id
      WHERE sp.id = product_id AND sel.user_id = auth.uid()
    )
  );
CREATE POLICY "Admins can manage all stock" ON public.seller_product_stock
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Seller orders
CREATE POLICY "Buyers can view their orders" ON public.seller_orders
  FOR SELECT USING (auth.uid() = buyer_id);
CREATE POLICY "Sellers can view their sales" ON public.seller_orders
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.seller_profiles WHERE id = seller_id AND user_id = auth.uid())
  );
CREATE POLICY "Admins can view all seller orders" ON public.seller_orders
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

-- Seller withdrawals
CREATE POLICY "Sellers can view own withdrawals" ON public.seller_withdrawals
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.seller_profiles WHERE id = seller_id AND user_id = auth.uid())
  );
CREATE POLICY "Sellers can create withdrawals" ON public.seller_withdrawals
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.seller_profiles WHERE id = seller_id AND user_id = auth.uid())
  );
CREATE POLICY "Admins can manage withdrawals" ON public.seller_withdrawals
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Seller balance logs
CREATE POLICY "Sellers can view own balance logs" ON public.seller_balance_logs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.seller_profiles WHERE id = seller_id AND user_id = auth.uid())
  );
CREATE POLICY "Admins can view all balance logs" ON public.seller_balance_logs
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

-- Functions

-- Get seller stock count
CREATE OR REPLACE FUNCTION public.get_seller_stock_count(p_product_id UUID)
RETURNS INT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::INT FROM public.seller_product_stock WHERE product_id = p_product_id AND status = 1;
$$;

-- Purchase from seller
CREATE OR REPLACE FUNCTION public.purchase_seller_product(
  p_buyer_id UUID,
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
  v_seller RECORD;
  v_buyer_balance DECIMAL(12,2);
  v_total_price DECIMAL(12,2);
  v_commission DECIMAL(12,2);
  v_seller_earning DECIMAL(12,2);
  v_order_id UUID;
  v_batch_id TEXT;
  v_stock_ids UUID[];
  v_new_buyer_balance DECIMAL(12,2);
  v_new_seller_balance DECIMAL(12,2);
BEGIN
  -- Lock buyer row
  SELECT balance INTO v_buyer_balance
  FROM public.profiles
  WHERE user_id = p_buyer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Buyer not found');
  END IF;

  -- Get product and seller info
  SELECT sp.*, sel.id as seller_profile_id, sel.commission_rate, sel.balance as seller_balance, sel.user_id as seller_user_id
  INTO v_product
  FROM public.seller_products sp
  JOIN public.seller_profiles sel ON sp.seller_id = sel.id
  WHERE sp.id = p_product_id AND sp.is_active = true AND sel.is_active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Product not found');
  END IF;

  -- Prevent buying own products
  IF v_product.seller_user_id = p_buyer_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot buy your own products');
  END IF;

  -- Calculate prices
  v_total_price := v_product.price * p_quantity;
  v_commission := v_total_price * (v_product.commission_rate / 100);
  v_seller_earning := v_total_price - v_commission;

  -- Check buyer balance
  IF v_buyer_balance < v_total_price THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance', 'required', v_total_price, 'available', v_buyer_balance);
  END IF;

  -- Lock and get available stock
  SELECT ARRAY_AGG(id) INTO v_stock_ids
  FROM (
    SELECT id FROM public.seller_product_stock
    WHERE product_id = p_product_id AND status = 1
    ORDER BY created_at LIMIT p_quantity
    FOR UPDATE SKIP LOCKED
  ) locked_rows;

  IF v_stock_ids IS NULL OR array_length(v_stock_ids, 1) < p_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not enough stock', 'requested', p_quantity, 'available', COALESCE(array_length(v_stock_ids, 1), 0));
  END IF;

  -- Generate batch ID
  v_batch_id := 'SORD' || to_char(now(), 'YYYYMMDD') || '#' || floor(random() * 900000 + 100000)::text;

  -- Create order
  INSERT INTO public.seller_orders (buyer_id, seller_id, product_id, batch_id, product_name, quantity, price_per_item, total_price, seller_earning, commission_amount, replacement_deadline)
  VALUES (p_buyer_id, v_product.seller_profile_id, p_product_id, v_batch_id, v_product.name, p_quantity, v_product.price, v_total_price, v_seller_earning, v_commission,
    CASE WHEN v_product.replacement_hours > 0 THEN now() + (v_product.replacement_hours || ' hours')::interval ELSE NULL END)
  RETURNING id INTO v_order_id;

  -- Update stock
  UPDATE public.seller_product_stock
  SET status = 2, order_id = v_order_id, sold_at = now()
  WHERE id = ANY(v_stock_ids);

  -- Deduct buyer balance
  v_new_buyer_balance := v_buyer_balance - v_total_price;
  UPDATE public.profiles SET balance = v_new_buyer_balance WHERE user_id = p_buyer_id;

  -- Add to seller balance
  v_new_seller_balance := v_product.seller_balance + v_seller_earning;
  UPDATE public.seller_profiles 
  SET balance = v_new_seller_balance, 
      total_sales = total_sales + v_total_price,
      total_orders = total_orders + 1
  WHERE id = v_product.seller_profile_id;

  -- Log buyer balance
  INSERT INTO public.balance_logs (user_id, previous_balance, change_amount, new_balance, type, reference_id, description)
  VALUES (p_buyer_id, v_buyer_balance, -v_total_price, v_new_buyer_balance, 'purchase', v_order_id, 'Purchase from seller: ' || v_product.name || ' x' || p_quantity);

  -- Log seller balance
  INSERT INTO public.seller_balance_logs (seller_id, previous_balance, change_amount, new_balance, type, reference_id, description)
  VALUES (v_product.seller_profile_id, v_product.seller_balance, v_seller_earning, v_new_seller_balance, 'sale', v_order_id, 'Sale: ' || v_product.name || ' x' || p_quantity || ' (Commission: $' || v_commission || ')');

  -- Notify buyer
  INSERT INTO public.notifications (user_id, title, message, type, link)
  VALUES (p_buyer_id, 'Order Completed', 'Your order ' || v_batch_id || ' is ready!', 'success', '/seller-orders/' || v_order_id::text);

  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'batch_id', v_batch_id,
    'quantity', p_quantity,
    'total_price', v_total_price,
    'new_balance', v_new_buyer_balance
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Get seller order items
CREATE OR REPLACE FUNCTION public.get_seller_order_items(p_order_id UUID, p_user_id UUID)
RETURNS TABLE(account_data TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.seller_orders WHERE id = p_order_id AND buyer_id = p_user_id) THEN
    RAISE EXCEPTION 'Order not found or access denied';
  END IF;

  UPDATE public.seller_orders SET download_count = download_count + 1 WHERE id = p_order_id;

  RETURN QUERY
  SELECT sps.account_data
  FROM public.seller_product_stock sps
  WHERE sps.order_id = p_order_id
  ORDER BY sps.sold_at;
END;
$$;

-- Triggers
CREATE TRIGGER update_seller_profiles_updated_at BEFORE UPDATE ON public.seller_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_seller_products_updated_at BEFORE UPDATE ON public.seller_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
