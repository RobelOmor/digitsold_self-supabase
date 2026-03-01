-- Add 2FA secret storage to profiles table
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS two_factor_secret TEXT;

-- Add 2FA backup codes for recovery
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS two_factor_backup_codes TEXT[];

-- Add 2FA verified timestamp
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS two_factor_verified_at TIMESTAMPTZ;