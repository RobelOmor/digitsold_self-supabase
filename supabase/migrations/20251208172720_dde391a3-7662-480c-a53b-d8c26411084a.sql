-- Add new SEO and content fields to blogs table
ALTER TABLE public.blogs 
ADD COLUMN IF NOT EXISTS primary_image_alt TEXT,
ADD COLUMN IF NOT EXISTS additional_images_alt TEXT[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS schema_type TEXT DEFAULT 'Article',
ADD COLUMN IF NOT EXISTS faq_items JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS robots_index BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS robots_follow BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS exclude_sitemap BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS category TEXT,
ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS author_name TEXT,
ADD COLUMN IF NOT EXISTS author_bio TEXT;

-- Create blog_categories table for organized category management
CREATE TABLE IF NOT EXISTS public.blog_categories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  parent_id UUID REFERENCES public.blog_categories(id),
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on blog_categories
ALTER TABLE public.blog_categories ENABLE ROW LEVEL SECURITY;

-- Policy for public read access
CREATE POLICY "Anyone can view blog categories" 
ON public.blog_categories 
FOR SELECT 
USING (true);

-- Policy for moderators and admins to manage categories
CREATE POLICY "Moderators and admins can manage blog categories" 
ON public.blog_categories 
FOR ALL 
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_id = auth.uid() 
    AND role IN ('moderator', 'admin')
  )
);

-- Add trigger for updated_at
CREATE TRIGGER update_blog_categories_updated_at
BEFORE UPDATE ON public.blog_categories
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();