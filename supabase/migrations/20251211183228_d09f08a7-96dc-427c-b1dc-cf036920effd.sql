-- Add hash columns for additional security verification
ALTER TABLE public.seller_profiles 
ADD COLUMN IF NOT EXISTS pending_balance_hash text;

-- Add encrypted columns for sensitive data
ALTER TABLE public.deposits 
ADD COLUMN IF NOT EXISTS wallet_address_encrypted text;

ALTER TABLE public.seller_withdrawals 
ADD COLUMN IF NOT EXISTS wallet_address_encrypted text;

ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS telegram_id_encrypted text;

ALTER TABLE public.seller_profiles 
ADD COLUMN IF NOT EXISTS telegram_contact_encrypted text;

ALTER TABLE public.login_logs 
ADD COLUMN IF NOT EXISTS ip_address_hash text;

-- Add comment for documentation
COMMENT ON COLUMN public.seller_profiles.pending_balance_hash IS 'HMAC hash for pending balance integrity verification';
COMMENT ON COLUMN public.deposits.wallet_address_encrypted IS 'AES-256-GCM encrypted wallet address';
COMMENT ON COLUMN public.seller_withdrawals.wallet_address_encrypted IS 'AES-256-GCM encrypted wallet address';
COMMENT ON COLUMN public.profiles.telegram_id_encrypted IS 'AES-256-GCM encrypted telegram ID';
COMMENT ON COLUMN public.seller_profiles.telegram_contact_encrypted IS 'AES-256-GCM encrypted telegram contact';
COMMENT ON COLUMN public.login_logs.ip_address_hash IS 'SHA-256 hashed IP address for privacy';