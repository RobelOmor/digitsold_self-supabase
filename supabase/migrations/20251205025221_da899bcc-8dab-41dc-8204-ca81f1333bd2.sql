-- Add delivery_type column to seller_products (instant or manual)
ALTER TABLE public.seller_products
ADD COLUMN delivery_type TEXT NOT NULL DEFAULT 'instant' CHECK (delivery_type IN ('instant', 'manual'));

COMMENT ON COLUMN public.seller_products.delivery_type IS 'instant = auto delivery with stock, manual = seller delivers via chat';