-- Add refund tracking to seller_orders
ALTER TABLE public.seller_orders 
ADD COLUMN IF NOT EXISTS refund_amount numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS refund_quantity integer DEFAULT 0;

-- Add last_message_at tracking to order_chats for 24h auto-completion
ALTER TABLE public.order_chats 
ADD COLUMN IF NOT EXISTS last_message_at timestamp with time zone DEFAULT now();

-- Create function to update last_message_at on new messages
CREATE OR REPLACE FUNCTION public.update_chat_last_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.order_chats 
  SET last_message_at = now(), updated_at = now()
  WHERE id = NEW.chat_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger for auto-updating last_message_at
DROP TRIGGER IF EXISTS trigger_update_chat_last_message ON public.chat_messages;
CREATE TRIGGER trigger_update_chat_last_message
AFTER INSERT ON public.chat_messages
FOR EACH ROW
EXECUTE FUNCTION public.update_chat_last_message();

-- Create function for processing refunds (seller to buyer)
CREATE OR REPLACE FUNCTION public.process_dispute_refund(
  p_order_id uuid,
  p_refund_quantity integer,
  p_refund_by text DEFAULT 'moderator'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_seller RECORD;
  v_buyer_profile RECORD;
  v_refund_amount numeric;
  v_new_seller_pending numeric;
  v_new_buyer_balance numeric;
  v_is_full_refund boolean;
  v_new_status text;
BEGIN
  -- Get order info
  SELECT * INTO v_order FROM public.seller_orders WHERE id = p_order_id FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found');
  END IF;
  
  IF v_order.status NOT IN ('in_progress', 'disputed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order cannot be refunded in current status');
  END IF;
  
  -- Validate refund quantity
  IF p_refund_quantity <= 0 OR p_refund_quantity > v_order.quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid refund quantity');
  END IF;
  
  -- Calculate refund amount
  v_refund_amount := v_order.price_per_item * p_refund_quantity;
  v_is_full_refund := (p_refund_quantity = v_order.quantity);
  v_new_status := CASE WHEN v_is_full_refund THEN 'full_refund' ELSE 'partial_refund' END;
  
  -- Get seller info
  SELECT * INTO v_seller FROM public.seller_profiles WHERE id = v_order.seller_id FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Seller not found');
  END IF;
  
  -- Get buyer profile
  SELECT * INTO v_buyer_profile FROM public.profiles WHERE user_id = v_order.buyer_id FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Buyer not found');
  END IF;
  
  -- Calculate new balances
  -- Deduct from seller's pending balance (the full earning amount for refunded quantity)
  v_new_seller_pending := v_seller.pending_balance - (v_order.seller_earning * p_refund_quantity / v_order.quantity);
  v_new_buyer_balance := v_buyer_profile.balance + v_refund_amount;
  
  -- Update seller pending balance
  UPDATE public.seller_profiles 
  SET pending_balance = GREATEST(0, v_new_seller_pending)
  WHERE id = v_order.seller_id;
  
  -- Update buyer balance
  UPDATE public.profiles 
  SET balance = v_new_buyer_balance
  WHERE user_id = v_order.buyer_id;
  
  -- Update order with refund info and status
  UPDATE public.seller_orders 
  SET 
    refund_amount = COALESCE(refund_amount, 0) + v_refund_amount,
    refund_quantity = COALESCE(refund_quantity, 0) + p_refund_quantity,
    status = v_new_status
  WHERE id = p_order_id;
  
  -- Update chat status to completed if full refund
  IF v_is_full_refund THEN
    UPDATE public.order_chats 
    SET status = 'completed', completed_at = now()
    WHERE order_id = p_order_id;
  END IF;
  
  -- Log buyer balance change
  INSERT INTO public.balance_logs (user_id, previous_balance, change_amount, new_balance, type, reference_id, description)
  VALUES (v_order.buyer_id, v_buyer_profile.balance, v_refund_amount, v_new_buyer_balance, 'refund', p_order_id, 
    'Dispute refund: ' || v_order.product_name || ' x' || p_refund_quantity || ' (' || p_refund_by || ')');
  
  -- Log seller balance change
  INSERT INTO public.seller_balance_logs (seller_id, previous_balance, change_amount, new_balance, type, reference_id, description)
  VALUES (v_order.seller_id, v_seller.pending_balance, -(v_order.seller_earning * p_refund_quantity / v_order.quantity), 
    GREATEST(0, v_new_seller_pending), 'refund', p_order_id, 
    'Dispute refund: ' || v_order.product_name || ' x' || p_refund_quantity || ' (pending balance deducted)');
  
  RETURN jsonb_build_object(
    'success', true,
    'refund_amount', v_refund_amount,
    'refund_quantity', p_refund_quantity,
    'is_full_refund', v_is_full_refund,
    'new_status', v_new_status,
    'new_buyer_balance', v_new_buyer_balance
  );
END;
$$;

-- Create function for 24h auto-completion check
CREATE OR REPLACE FUNCTION public.check_dispute_auto_completion()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_chat RECORD;
  v_completed_count integer := 0;
BEGIN
  -- Find disputed chats where last message was more than 24 hours ago
  FOR v_chat IN 
    SELECT oc.*, so.id as seller_order_id
    FROM public.order_chats oc
    JOIN public.seller_orders so ON oc.order_id = so.id
    WHERE oc.status = 'disputed'
    AND oc.last_message_at < (now() - interval '24 hours')
  LOOP
    -- Auto-complete the order (seller wins)
    UPDATE public.order_chats 
    SET status = 'completed', completed_at = now()
    WHERE id = v_chat.id;
    
    -- Complete the seller order (release funds)
    PERFORM public.complete_seller_order(v_chat.seller_order_id);
    
    -- Add system message
    INSERT INTO public.chat_messages (chat_id, sender_id, sender_role, message, message_type)
    VALUES (v_chat.id, v_chat.seller_id, 'system', 
      '⏰ 24 hours passed without response. Dispute auto-resolved in seller''s favor. Funds released to seller.',
      'system');
    
    v_completed_count := v_completed_count + 1;
  END LOOP;
  
  RETURN jsonb_build_object('success', true, 'completed_count', v_completed_count);
END;
$$;