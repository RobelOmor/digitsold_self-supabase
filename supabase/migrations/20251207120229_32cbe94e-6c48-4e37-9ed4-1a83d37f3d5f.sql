-- Update seller_products.price to support 3 decimal places
ALTER TABLE public.seller_products ALTER COLUMN price TYPE numeric(10, 3);

-- Update products.price to support 3 decimal places
ALTER TABLE public.products ALTER COLUMN price TYPE numeric(10, 3);