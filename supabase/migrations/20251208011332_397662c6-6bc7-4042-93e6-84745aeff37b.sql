-- Add fee_amount and fee_percentage to seller_withdrawals
ALTER TABLE public.seller_withdrawals 
ADD COLUMN IF NOT EXISTS fee_percentage numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS fee_amount numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS net_amount numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS proof_image_url text,
ADD COLUMN IF NOT EXISTS buyer_user_id uuid;

-- Update status constraint to include new statuses
-- First drop any existing constraint if it exists
ALTER TABLE public.seller_withdrawals DROP CONSTRAINT IF EXISTS seller_withdrawals_status_check;

-- Add comment to document valid statuses: pending, paid, in_progress, refund_back, cancelled