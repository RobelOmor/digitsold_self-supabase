-- Fix any order_chats where completed_at is set but status is still 'disputed'
UPDATE public.order_chats 
SET status = 'completed'
WHERE completed_at IS NOT NULL AND status = 'disputed';