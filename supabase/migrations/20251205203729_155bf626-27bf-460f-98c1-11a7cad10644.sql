-- Function to process replacement from seller stock
CREATE OR REPLACE FUNCTION process_replacement(
  p_order_id UUID,
  p_replacement_quantity INTEGER,
  p_seller_user_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order seller_orders%ROWTYPE;
  v_seller seller_profiles%ROWTYPE;
  v_locked_stock_ids UUID[];
  v_locked_count INTEGER;
BEGIN
  -- Get order details
  SELECT * INTO v_order FROM seller_orders WHERE id = p_order_id;
  
  IF v_order.id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Order not found');
  END IF;

  -- Get seller profile
  SELECT * INTO v_seller FROM seller_profiles WHERE user_id = p_seller_user_id;
  
  IF v_seller.id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Seller not found');
  END IF;

  -- Verify seller owns this order
  IF v_order.seller_id != v_seller.id THEN
    RETURN json_build_object('success', false, 'error', 'Unauthorized');
  END IF;

  -- Validate replacement quantity
  IF p_replacement_quantity <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'Invalid replacement quantity');
  END IF;

  -- Lock available stock for this product
  SELECT ARRAY_AGG(id) INTO v_locked_stock_ids
  FROM (
    SELECT id FROM seller_product_stock 
    WHERE product_id = v_order.product_id 
    AND status = 1
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT p_replacement_quantity
  ) locked;

  v_locked_count := COALESCE(array_length(v_locked_stock_ids, 1), 0);

  IF v_locked_count < p_replacement_quantity THEN
    RETURN json_build_object(
      'success', false, 
      'error', 'Insufficient stock. Only ' || v_locked_count || ' items available.'
    );
  END IF;

  -- Mark stock as sold (replacement) with the order_id
  UPDATE seller_product_stock
  SET status = 2, 
      order_id = p_order_id, 
      sold_at = NOW()
  WHERE id = ANY(v_locked_stock_ids);

  -- Update order max_downloads
  UPDATE seller_orders
  SET max_downloads = max_downloads + p_replacement_quantity
  WHERE id = p_order_id;

  RETURN json_build_object(
    'success', true, 
    'replacement_quantity', p_replacement_quantity,
    'stock_ids', v_locked_stock_ids
  );
END;
$$;