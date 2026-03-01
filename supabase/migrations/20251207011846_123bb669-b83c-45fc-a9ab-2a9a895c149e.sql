-- Fix the specific order chat that is stuck as disputed
UPDATE public.order_chats 
SET status = 'completed'
WHERE completed_at IS NOT NULL AND status = 'disputed';

-- Also create a trigger to ensure order_chats status is synced when completed_at is set
CREATE OR REPLACE FUNCTION public.sync_chat_status_on_completion()
RETURNS TRIGGER AS $$
BEGIN
  -- If completed_at is being set and status is still disputed, change to completed
  IF NEW.completed_at IS NOT NULL AND NEW.status = 'disputed' THEN
    NEW.status := 'completed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_chat_status_trigger ON public.order_chats;
CREATE TRIGGER sync_chat_status_trigger
BEFORE UPDATE ON public.order_chats
FOR EACH ROW
EXECUTE FUNCTION public.sync_chat_status_on_completion();