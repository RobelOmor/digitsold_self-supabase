-- Add webhook_active column to bot_resellers
ALTER TABLE public.bot_resellers 
ADD COLUMN IF NOT EXISTS webhook_active boolean NOT NULL DEFAULT false;