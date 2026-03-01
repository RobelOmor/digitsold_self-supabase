-- Fix function search path security issue
CREATE OR REPLACE FUNCTION public.sync_chat_status_on_completion()
RETURNS TRIGGER 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- If completed_at is being set and status is still disputed, change to completed
  IF NEW.completed_at IS NOT NULL AND NEW.status = 'disputed' THEN
    NEW.status := 'completed';
  END IF;
  RETURN NEW;
END;
$$;