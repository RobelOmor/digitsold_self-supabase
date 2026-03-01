-- Add encrypted PIN column to seller_profiles
ALTER TABLE public.seller_profiles 
ADD COLUMN IF NOT EXISTS seller_pin_hash TEXT DEFAULT NULL;

-- Add store_logo column for seller's custom store logo
ALTER TABLE public.seller_profiles 
ADD COLUMN IF NOT EXISTS store_logo TEXT DEFAULT NULL;