-- Create admin take stock history table
CREATE TABLE public.admin_take_stock_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  quality_id UUID NOT NULL REFERENCES public.admin_account_qualities(id) ON DELETE CASCADE,
  quality_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  stock_data TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.admin_take_stock_history ENABLE ROW LEVEL SECURITY;

-- Admin can manage their take stock history
CREATE POLICY "Admins can manage take stock history"
ON public.admin_take_stock_history
FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- Create index for faster queries
CREATE INDEX idx_admin_take_stock_history_quality_id ON public.admin_take_stock_history(quality_id);
CREATE INDEX idx_admin_take_stock_history_created_at ON public.admin_take_stock_history(created_at DESC);