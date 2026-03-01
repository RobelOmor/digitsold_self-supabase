-- Create table for Take Stock History
CREATE TABLE public.take_stock_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seller_id UUID NOT NULL REFERENCES public.seller_profiles(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.seller_products(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  stock_data TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.take_stock_history ENABLE ROW LEVEL SECURITY;

-- Policy: Sellers can view their own take stock history
CREATE POLICY "Sellers can view own take stock history"
  ON public.take_stock_history
  FOR SELECT
  USING (
    seller_id IN (
      SELECT id FROM public.seller_profiles WHERE user_id = auth.uid()
    )
  );

-- Policy: Sellers can insert their own take stock history
CREATE POLICY "Sellers can insert own take stock history"
  ON public.take_stock_history
  FOR INSERT
  WITH CHECK (
    seller_id IN (
      SELECT id FROM public.seller_profiles WHERE user_id = auth.uid()
    )
  );

-- Policy: Sellers can delete their own take stock history
CREATE POLICY "Sellers can delete own take stock history"
  ON public.take_stock_history
  FOR DELETE
  USING (
    seller_id IN (
      SELECT id FROM public.seller_profiles WHERE user_id = auth.uid()
    )
  );

-- Create index for faster queries
CREATE INDEX idx_take_stock_history_seller_product ON public.take_stock_history(seller_id, product_id);
CREATE INDEX idx_take_stock_history_created_at ON public.take_stock_history(created_at DESC);