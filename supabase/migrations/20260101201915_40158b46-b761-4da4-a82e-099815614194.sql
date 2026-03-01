-- Add encryption_key_hash column to admin_account_qualities to verify the same key is used for all stock additions
ALTER TABLE public.admin_account_qualities 
ADD COLUMN IF NOT EXISTS encryption_key_hash text;