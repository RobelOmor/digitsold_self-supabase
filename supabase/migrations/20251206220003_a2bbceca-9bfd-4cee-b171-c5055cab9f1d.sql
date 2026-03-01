-- Add platform fee setting
INSERT INTO public.site_settings (key, value, description)
VALUES ('platform_fee', '20', 'Default platform fee percentage for sellers')
ON CONFLICT (key) DO NOTHING;