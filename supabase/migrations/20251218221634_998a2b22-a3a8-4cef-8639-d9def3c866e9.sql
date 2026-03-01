-- Add label column to admin_take_stock_history table
ALTER TABLE public.admin_take_stock_history
ADD COLUMN label text DEFAULT NULL;