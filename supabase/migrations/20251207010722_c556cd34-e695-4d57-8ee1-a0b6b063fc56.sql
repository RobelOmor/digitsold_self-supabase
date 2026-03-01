-- Create function to auto-complete in_progress orders after 24 hours
CREATE OR REPLACE FUNCTION public.check_in_progress_auto_completion()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order RECORD;
  v_completed_count integer := 0;
BEGIN
  -- Find in_progress seller orders that are older than 24 hours
  FOR v_order IN 
    SELECT so.id, so.seller_id, so.product_name, so.seller_earning
    FROM public.seller_orders so
    WHERE so.status = 'in_progress'
    AND so.created_at < (now() - interval '24 hours')
  LOOP
    -- Complete the seller order (release funds from pending to available)
    PERFORM public.complete_seller_order(v_order.id);
    
    -- Check if there's an associated chat and update it
    UPDATE public.order_chats 
    SET status = 'completed', completed_at = now()
    WHERE order_id = v_order.id AND status IN ('active', 'delivered');
    
    -- Add system message if chat exists
    INSERT INTO public.chat_messages (chat_id, sender_id, sender_role, message, message_type)
    SELECT 
      oc.id,
      oc.seller_id,
      'system',
      '⏰ 24 hours passed since order creation. Order auto-completed. Funds released to seller.',
      'completed'
    FROM public.order_chats oc
    WHERE oc.order_id = v_order.id;
    
    v_completed_count := v_completed_count + 1;
  END LOOP;
  
  RETURN jsonb_build_object('success', true, 'completed_count', v_completed_count);
END;
$function$;

-- Also fix any existing order_chats that have completed_at but status is still disputed
UPDATE public.order_chats 
SET status = 'completed'
WHERE completed_at IS NOT NULL AND status = 'disputed';