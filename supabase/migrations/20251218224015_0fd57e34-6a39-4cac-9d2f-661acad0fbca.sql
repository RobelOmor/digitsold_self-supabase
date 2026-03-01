-- Add store_url_username column to seller_profiles
ALTER TABLE public.seller_profiles 
ADD COLUMN store_url_username text UNIQUE;

-- Create index for fast username lookups
CREATE INDEX idx_seller_profiles_store_url_username ON public.seller_profiles(store_url_username);

-- Function to generate unique store URL username from store name
CREATE OR REPLACE FUNCTION public.generate_store_url_username(p_store_name text)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_base_slug text;
  v_slug text;
  v_suffix text;
  v_exists boolean;
BEGIN
  -- Convert store name to slug: lowercase, replace spaces/special chars with hyphens
  v_base_slug := lower(regexp_replace(trim(p_store_name), '[^a-zA-Z0-9]+', '-', 'g'));
  -- Remove leading/trailing hyphens
  v_base_slug := trim(both '-' from v_base_slug);
  -- Limit length
  v_base_slug := left(v_base_slug, 40);
  
  -- Generate random suffix
  v_suffix := floor(random() * 90000 + 10000)::text;
  v_slug := v_base_slug || '-' || v_suffix;
  
  -- Check if exists and regenerate if needed
  SELECT EXISTS(SELECT 1 FROM public.seller_profiles WHERE store_url_username = v_slug) INTO v_exists;
  WHILE v_exists LOOP
    v_suffix := floor(random() * 90000 + 10000)::text;
    v_slug := v_base_slug || '-' || v_suffix;
    SELECT EXISTS(SELECT 1 FROM public.seller_profiles WHERE store_url_username = v_slug) INTO v_exists;
  END LOOP;
  
  RETURN v_slug;
END;
$$;