-- Create admin_account_qualities table to store service account quality types
CREATE TABLE public.admin_account_qualities (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  serial_no SERIAL,
  name TEXT NOT NULL UNIQUE,
  account_data_format TEXT DEFAULT 'email|password',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create admin_account_stock table to store the stock items
CREATE TABLE public.admin_account_stock (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  quality_id UUID NOT NULL REFERENCES public.admin_account_qualities(id) ON DELETE CASCADE,
  account_data TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.admin_account_qualities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_account_stock ENABLE ROW LEVEL SECURITY;

-- RLS policies for admin_account_qualities
CREATE POLICY "Admins can manage account qualities"
ON public.admin_account_qualities
FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS policies for admin_account_stock
CREATE POLICY "Admins can manage account stock"
ON public.admin_account_stock
FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- Function to get stock count for admin account quality
CREATE OR REPLACE FUNCTION public.get_admin_account_stock_count(p_quality_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::INT FROM public.admin_account_stock WHERE quality_id = p_quality_id AND status = 1;
$$;

-- Create index for faster queries
CREATE INDEX idx_admin_account_stock_quality_status ON public.admin_account_stock(quality_id, status);