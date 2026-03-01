-- Add content_hash column to seller_product_stock for duplicate detection
ALTER TABLE public.seller_product_stock 
ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Create index for fast duplicate checking
CREATE INDEX IF NOT EXISTS idx_seller_product_stock_content_hash 
ON public.seller_product_stock(product_id, content_hash) 
WHERE content_hash IS NOT NULL;