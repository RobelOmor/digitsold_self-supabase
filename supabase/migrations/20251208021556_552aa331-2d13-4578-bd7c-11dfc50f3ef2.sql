-- Add RLS policy to allow sellers to insert their own balance logs
CREATE POLICY "Sellers can insert their own balance logs"
ON public.seller_balance_logs
FOR INSERT
WITH CHECK (
  seller_id IN (
    SELECT id FROM seller_profiles WHERE user_id = auth.uid()
  )
);

-- Also ensure sellers can view their own balance logs
CREATE POLICY "Sellers can view their own balance logs"
ON public.seller_balance_logs
FOR SELECT
USING (
  seller_id IN (
    SELECT id FROM seller_profiles WHERE user_id = auth.uid()
  )
);