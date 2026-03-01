-- Create site_settings table for storing editable SEO and site configuration
CREATE TABLE public.site_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  key text NOT NULL UNIQUE,
  value text NOT NULL,
  description text,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid
);

-- Enable RLS
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read site settings (needed for SEO)
CREATE POLICY "Anyone can view site settings" 
ON public.site_settings 
FOR SELECT 
USING (true);

-- Only admins can manage site settings
CREATE POLICY "Admins can manage site settings" 
ON public.site_settings 
FOR ALL 
USING (has_role(auth.uid(), 'admin'::app_role));

-- Insert default settings
INSERT INTO public.site_settings (key, value, description) VALUES
('site_title', 'DigitSold - Digital Products Marketplace', 'Website title shown in browser tab'),
('meta_description', 'DigitSold is a secure digital products marketplace. Buy and sell digital goods with instant delivery, encrypted transactions, and trusted sellers.', 'Meta description for search engines'),
('meta_keywords', 'digital products, marketplace, instant delivery, digital goods, secure transactions, online store', 'Keywords for SEO'),
('site_url', 'https://digitsold.com/', 'Canonical site URL'),
('theme_color', '#2563eb', 'Browser theme color'),
('og_image', '/logo.png', 'Open Graph image path'),
('author', 'DigitSold', 'Site author name');

-- Create trigger to update updated_at
CREATE TRIGGER update_site_settings_updated_at
BEFORE UPDATE ON public.site_settings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();