-- Create storage bucket for images
INSERT INTO storage.buckets (id, name, public)
VALUES ('images', 'images', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for images bucket
CREATE POLICY "Anyone can view images"
ON storage.objects FOR SELECT
USING (bucket_id = 'images');

CREATE POLICY "Authenticated users can upload images"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'images' AND auth.role() = 'authenticated');

CREATE POLICY "Users can update their own images"
ON storage.objects FOR UPDATE
USING (bucket_id = 'images' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete their own images"
ON storage.objects FOR DELETE
USING (bucket_id = 'images' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Add additional_images column to seller_products
ALTER TABLE public.seller_products
ADD COLUMN IF NOT EXISTS additional_images text[] DEFAULT '{}';

-- Add icon column to categories  
ALTER TABLE public.categories
ADD COLUMN IF NOT EXISTS icon_url text;

-- Add icon column to subcategories
ALTER TABLE public.subcategories
ADD COLUMN IF NOT EXISTS icon_url text;