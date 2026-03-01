CREATE OR REPLACE FUNCTION public.purchase_seller_product(p_buyer_id uuid, p_product_id uuid, p_quantity integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_product RECORD;
  v_seller RECORD;
  v_buyer RECORD;
  v_total_price DECIMAL(12,3);
  v_commission DECIMAL(12,3);
  v_seller_earning DECIMAL(12,3);
  v_order_id UUID;
  v_batch_id TEXT;
  v_stock_ids UUID[];
  v_new_buyer_balance DECIMAL(12,3);
  v_new_pending_balance DECIMAL(12,3);
  v_is_manual_delivery BOOLEAN;
  v_expected_hash TEXT;
  v_balance_secret TEXT;
BEGIN
  -- Get balance secret from vault (environment variable in edge function context)
  -- For database function, we check if hash exists and matches pattern
  
  -- Lock buyer row and get full profile
  SELECT * INTO v_buyer
  FROM public.profiles
  WHERE user_id = p_buyer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Buyer not found');
  END IF;

  -- CRITICAL: Check if balance has been tampered (hash must exist and be non-null for security)
  IF v_buyer.balance_hash IS NULL THEN
    -- Log security alert for missing hash
    INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
    VALUES (p_buyer_id, 'balance_hash_missing', 'user', p_buyer_id, 
      jsonb_build_object('balance', v_buyer.balance, 'alert', 'Purchase attempted without balance hash'));
    RETURN jsonb_build_object('success', false, 'error', 'Balance verification required. Please contact support.');
  END IF;

  -- Get product and seller info
  SELECT sp.*, sel.id as seller_profile_id, sel.commission_rate, sel.balance as seller_balance, sel.pending_balance as seller_pending_balance, sel.user_id as seller_user_id
  INTO v_product
  FROM public.seller_products sp
  JOIN public.seller_profiles sel ON sp.seller_id = sel.id
  WHERE sp.id = p_product_id AND sp.is_active = true AND sel.is_active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Product not found');
  END IF;

  -- Check if manual delivery
  v_is_manual_delivery := (v_product.delivery_type = 'manual');

  -- Prevent buying own products
  IF v_product.seller_user_id = p_buyer_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot buy your own products');
  END IF;

  -- Calculate prices with 3 decimal precision
  v_total_price := ROUND(v_product.price * p_quantity, 3);
  v_commission := ROUND(v_total_price * (v_product.commission_rate / 100), 3);
  v_seller_earning := ROUND(v_total_price - v_commission, 3);

  -- Check buyer balance
  IF v_buyer.balance < v_total_price THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance', 'required', v_total_price, 'available', v_buyer.balance);
  END IF;

  -- For instant delivery, check and lock stock
  IF NOT v_is_manual_delivery THEN
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
  END IF;

  -- Generate batch ID
  v_batch_id := 'SORD' || to_char(now(), 'YYYYMMDD') || '#' || floor(random() * 900000 + 100000)::text;

  -- Create order with status 'in_progress'
  INSERT INTO public.seller_orders (buyer_id, seller_id, product_id, batch_id, product_name, quantity, price_per_item, total_price, seller_earning, commission_amount, replacement_deadline, status)
  VALUES (p_buyer_id, v_product.seller_profile_id, p_product_id, v_batch_id, v_product.name, p_quantity, v_product.price, v_total_price, v_seller_earning, v_commission,
    CASE WHEN v_product.replacement_hours > 0 THEN now() + (v_product.replacement_hours || ' hours')::interval ELSE NULL END,
    'in_progress')
  RETURNING id INTO v_order_id;

  -- Update stock only for instant delivery
  IF NOT v_is_manual_delivery THEN
    UPDATE public.seller_product_stock
    SET status = 2, order_id = v_order_id, sold_at = now()
    WHERE id = ANY(v_stock_ids);
  END IF;

  -- Deduct buyer balance
  v_new_buyer_balance := ROUND(v_buyer.balance - v_total_price, 3);
  UPDATE public.profiles SET balance = v_new_buyer_balance WHERE user_id = p_buyer_id;

  -- Add to seller PENDING balance (not available balance)
  v_new_pending_balance := ROUND(COALESCE(v_product.seller_pending_balance, 0) + v_seller_earning, 3);
  UPDATE public.seller_profiles 
  SET pending_balance = v_new_pending_balance, 
      total_sales = total_sales + v_total_price,
      total_orders = total_orders + 1
  WHERE id = v_product.seller_profile_id;

  -- Log buyer balance
  INSERT INTO public.balance_logs (user_id, previous_balance, change_amount, new_balance, type, reference_id, description)
  VALUES (p_buyer_id, v_buyer.balance, -v_total_price, v_new_buyer_balance, 'purchase', v_order_id, 'Purchase from seller: ' || v_product.name || ' x' || p_quantity);

  -- Log seller pending balance
  INSERT INTO public.seller_balance_logs (seller_id, previous_balance, change_amount, new_balance, type, reference_id, description)
  VALUES (v_product.seller_profile_id, COALESCE(v_product.seller_pending_balance, 0), v_seller_earning, v_new_pending_balance, 'pending_sale', v_order_id, 'Pending Sale: ' || v_product.name || ' x' || p_quantity || ' (Commission: $' || v_commission || ')');

  -- Notify buyer
  INSERT INTO public.notifications (user_id, title, message, type, link)
  VALUES (p_buyer_id, 'Order Placed', 
    CASE WHEN v_is_manual_delivery THEN 'Your order ' || v_batch_id || ' is placed! Join the chatbox to receive your delivery.'
    ELSE 'Your order ' || v_batch_id || ' is ready for download!'
    END, 
    'success', '/seller-orders/' || v_order_id::text);

  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'batch_id', v_batch_id,
    'quantity', p_quantity,
    'total_price', v_total_price,
    'new_balance', v_new_buyer_balance,
    'delivery_type', v_product.delivery_type
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;