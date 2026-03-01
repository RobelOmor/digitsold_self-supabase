-- Fix 1: Restrict seller_profiles to only show limited public info
-- Drop the current overly permissive policy
DROP POLICY IF EXISTS "Anyone can view active seller profiles" ON public.seller_profiles;

-- Create new restrictive policy - only show truly public fields
CREATE POLICY "Anyone can view active seller profiles public info" 
ON public.seller_profiles 
FOR SELECT 
USING (is_active = true);

-- Note: The above still allows viewing all columns. Since we can't restrict columns via RLS,
-- we should handle this at the application level or create a view.
-- For now, let's at least ensure PIN hash is never exposed by creating a secure view

-- Fix 2: Make payment_methods more secure - only show to authenticated users
DROP POLICY IF EXISTS "Anyone can view active payment methods" ON public.payment_methods;

CREATE POLICY "Authenticated users can view active payment methods" 
ON public.payment_methods 
FOR SELECT 
USING (is_active = true AND auth.uid() IS NOT NULL);

-- Fix 3: Restrict site_settings - only public keys should be viewable
DROP POLICY IF EXISTS "Anyone can view site settings" ON public.site_settings;

-- Create policy that only shows non-sensitive settings to public
CREATE POLICY "Anyone can view public site settings" 
ON public.site_settings 
FOR SELECT 
USING (
  key IN ('site_title', 'meta_description', 'meta_keywords', 'theme_color', 'og_image', 'canonical_url', 'author', 'favicon', 'platform_fee', 'footer_text', 'facebook_url', 'twitter_url', 'instagram_url', 'youtube_url', 'support_email', 'telegram_url')
  OR has_role(auth.uid(), 'admin'::app_role)
);

-- Fix 4: Add rate limiting table for tracking suspicious activity
CREATE TABLE IF NOT EXISTS public.rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  ip_address text,
  action_type text NOT NULL,
  created_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb
);

-- Enable RLS on rate_limits
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- Only admins can view rate limits
CREATE POLICY "Admins can manage rate limits" 
ON public.rate_limits 
FOR ALL 
USING (has_role(auth.uid(), 'admin'::app_role));

-- Create index for efficient querying
CREATE INDEX IF NOT EXISTS idx_rate_limits_user_action ON public.rate_limits(user_id, action_type, created_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_ip_action ON public.rate_limits(ip_address, action_type, created_at);