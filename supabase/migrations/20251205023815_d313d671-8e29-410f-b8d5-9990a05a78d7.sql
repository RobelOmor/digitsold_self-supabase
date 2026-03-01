-- Add account_data_format column to seller_products
ALTER TABLE public.seller_products 
ADD COLUMN account_data_format text DEFAULT 'email|password';