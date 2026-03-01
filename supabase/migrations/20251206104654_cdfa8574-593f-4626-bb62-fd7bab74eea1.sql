-- Add category_icons column to categories table for storing up to 6 icons
ALTER TABLE public.categories 
ADD COLUMN IF NOT EXISTS category_icons text[] DEFAULT '{}'::text[];