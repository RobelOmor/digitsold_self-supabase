-- Create admin refund function for seller orders
CREATE OR REPLACE FUNCTION public.admin_refund_seller_order(
  p_order_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order RECORD;
  v_seller RECORD;
  v_buyer_profile RECORD;
  v_refund_amount numeric;
  v_new_seller_pending numeric;
  v_new_buyer_balance numeric;
  v_hours_since_created numeric;
BEGIN
  -- Get order info with lock
  SELECT * INTO v_order FROM public.seller_orders WHERE id = p_order_id FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found');
  END IF;
  
  -- Check if order is already refunded or completed
  IF v_order.status IN ('completed', 'full_refund', 'partial_refund', 'admin_refunded') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order already completed or refunded. Cannot refund.');
  END IF;
  
  -- Check if within 24 hours
  v_hours_since_created := EXTRACT(EPOCH FROM (now() - v_order.created_at)) / 3600;
  IF v_hours_since_created > 24 THEN
    RETURN jsonb_build_object('success', false, 'error', '24 hours have passed. Cannot refund after 24 hours.');
  END IF;
  
  -- Get seller info
  SELECT * INTO v_seller FROM public.seller_profiles WHERE id = v_order.seller_id FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Seller not found');
  END IF;
  
  -- Check if funds are still in pending balance (not moved to available)
  IF v_seller.pending_balance < v_order.seller_earning THEN
    RETURN jsonb_build_object('success', false, 'error', 'Funds already moved to seller available balance. Cannot refund.');
  END IF;
  
  -- Get buyer profile
  SELECT * INTO v_buyer_profile FROM public.profiles WHERE user_id = v_order.buyer_id FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Buyer not found');
  END IF;
  
  -- Calculate refund amount (full order amount = seller_earning + commission)
  v_refund_amount := v_order.total_price;
  
  -- Deduct from seller's pending balance
  v_new_seller_pending := v_seller.pending_balance - v_order.seller_earning;
  
  -- Add to buyer's balance
  v_new_buyer_balance := v_buyer_profile.balance + v_refund_amount;
  
  -- Update seller pending balance
  UPDATE public.seller_profiles 
  SET pending_balance = GREATEST(0, v_new_seller_pending)
  WHERE id = v_order.seller_id;
  
  -- Update buyer balance
  UPDATE public.profiles 
  SET balance = v_new_buyer_balance
  WHERE user_id = v_order.buyer_id;
  
  -- Update order status to admin_refunded
  UPDATE public.seller_orders 
  SET 
    status = 'admin_refunded',
    refund_amount = v_refund_amount,
    refund_quantity = v_order.quantity
  WHERE id = p_order_id;
  
  -- Close any associated chat
  UPDATE public.order_chats 
  SET status = 'completed', completed_at = now()
  WHERE order_id = p_order_id;
  
  -- Log buyer balance change
  INSERT INTO public.balance_logs (user_id, previous_balance, change_amount, new_balance, type, reference_id, description)
  VALUES (v_order.buyer_id, v_buyer_profile.balance, v_refund_amount, v_new_buyer_balance, 'admin_refund', p_order_id, 
    'Admin Refund: ' || v_order.product_name || ' - ' || p_reason);
  
  -- Log seller balance change
  INSERT INTO public.seller_balance_logs (seller_id, previous_balance, change_amount, new_balance, type, reference_id, description)
  VALUES (v_order.seller_id, v_seller.pending_balance, -v_order.seller_earning, 
    GREATEST(0, v_new_seller_pending), 'admin_refund', p_order_id, 
    'Admin Refund: ' || v_order.product_name || ' - ' || p_reason);
  
  -- Notify buyer
  INSERT INTO public.notifications (user_id, title, message, type, link)
  VALUES (v_order.buyer_id, 'Order Refunded by Admin', 
    'Your order ' || v_order.batch_id || ' has been refunded. $' || v_refund_amount || ' added to your balance. Reason: ' || p_reason,
    'info', '/orders');
  
  -- Notify seller
  INSERT INTO public.notifications (user_id, title, message, type, link)
  SELECT sp.user_id, 'Order Refunded by Admin', 
    'Order ' || v_order.batch_id || ' has been refunded by admin. Reason: ' || p_reason,
    'warning', '/seller/orders'
  FROM public.seller_profiles sp WHERE sp.id = v_order.seller_id;
  
  RETURN jsonb_build_object(
    'success', true,
    'refund_amount', v_refund_amount,
    'new_buyer_balance', v_new_buyer_balance,
    'order_id', p_order_id
  );
END;
$function$;