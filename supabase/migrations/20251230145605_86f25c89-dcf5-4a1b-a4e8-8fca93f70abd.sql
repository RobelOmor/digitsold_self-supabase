-- Create TG Marketing Categories table
CREATE TABLE public.tg_marketing_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Add category_id to tg_marketing table
ALTER TABLE public.tg_marketing 
ADD COLUMN category_id uuid REFERENCES public.tg_marketing_categories(id) ON DELETE SET NULL;

-- Enable RLS on categories
ALTER TABLE public.tg_marketing_categories ENABLE ROW LEVEL SECURITY;

-- Admins can manage categories
CREATE POLICY "Admins can manage tg marketing categories" 
ON public.tg_marketing_categories 
FOR ALL 
USING (has_role(auth.uid(), 'admin'::app_role));

-- Moderators can view active categories
CREATE POLICY "Moderators can view active tg marketing categories" 
ON public.tg_marketing_categories 
FOR SELECT 
USING (is_active = true AND has_role(auth.uid(), 'moderator'::app_role));

-- Create index for faster lookups
CREATE INDEX idx_tg_marketing_category_id ON public.tg_marketing(category_id);
CREATE INDEX idx_tg_marketing_categories_sort ON public.tg_marketing_categories(sort_order);