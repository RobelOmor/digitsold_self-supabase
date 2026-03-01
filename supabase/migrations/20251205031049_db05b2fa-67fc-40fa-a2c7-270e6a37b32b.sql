-- Update default commission rate to 15%
ALTER TABLE public.seller_profiles 
ALTER COLUMN commission_rate SET DEFAULT 15.00;

-- Update existing sellers who have the old default (10%) to the new default (15%)
-- Only update if they still have the original default
UPDATE public.seller_profiles 
SET commission_rate = 15.00 
WHERE commission_rate = 10.00;