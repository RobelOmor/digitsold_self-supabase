-- Add label column to take_stock_history for sellers to note the purpose
ALTER TABLE public.take_stock_history 
ADD COLUMN IF NOT EXISTS label TEXT;

-- Add comment for the column
COMMENT ON COLUMN public.take_stock_history.label IS 'Optional label/note for the take stock action purpose';

-- Add auto-approve sellers setting
INSERT INTO public.site_settings (key, value, description) 
VALUES ('auto_approve_sellers', 'false', 'Automatically approve seller applications without manual review')
ON CONFLICT (key) DO NOTHING;

-- Add zero commission offer settings
INSERT INTO public.site_settings (key, value, description) 
VALUES ('zero_commission_enabled', 'false', 'Enable 0% commission promotional offer for sellers')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.site_settings (key, value, description) 
VALUES ('zero_commission_end_date', '', 'End date for 0% commission offer (ISO format, empty means indefinite when enabled)')
ON CONFLICT (key) DO NOTHING;