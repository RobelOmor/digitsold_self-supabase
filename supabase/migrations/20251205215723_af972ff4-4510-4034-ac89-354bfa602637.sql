-- Add RLS policy for moderators to view seller orders they're moderating
CREATE POLICY "Moderators can view orders they moderate" 
ON public.seller_orders 
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 FROM order_chats oc 
    WHERE oc.order_id = seller_orders.id 
    AND oc.moderator_id = auth.uid()
  )
);