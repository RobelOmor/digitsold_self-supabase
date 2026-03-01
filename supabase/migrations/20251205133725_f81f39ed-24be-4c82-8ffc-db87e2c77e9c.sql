-- Add balance_hash column to profiles table
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS balance_hash TEXT;

-- Add balance_hash column to seller_profiles table  
ALTER TABLE public.seller_profiles ADD COLUMN IF NOT EXISTS balance_hash TEXT;

-- Add comments explaining the purpose
COMMENT ON COLUMN public.profiles.balance_hash IS 'HMAC hash for balance integrity verification';
COMMENT ON COLUMN public.seller_profiles.balance_hash IS 'HMAC hash for seller balance integrity verification';