-- Create user_sessions table for single device login
CREATE TABLE public.user_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  session_token TEXT NOT NULL UNIQUE,
  device_info TEXT,
  ip_address TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (now() + interval '12 hours'),
  is_active BOOLEAN NOT NULL DEFAULT true
);

-- Enable RLS
ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

-- Users can view their own sessions
CREATE POLICY "Users can view own sessions" ON public.user_sessions
FOR SELECT USING (auth.uid() = user_id);

-- Users can delete their own sessions (logout)
CREATE POLICY "Users can delete own sessions" ON public.user_sessions
FOR DELETE USING (auth.uid() = user_id);

-- System can insert sessions (via trigger/function)
CREATE POLICY "System can manage sessions" ON public.user_sessions
FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

-- Index for fast lookups
CREATE INDEX idx_user_sessions_user_id ON public.user_sessions(user_id);
CREATE INDEX idx_user_sessions_token ON public.user_sessions(session_token);
CREATE INDEX idx_user_sessions_expires ON public.user_sessions(expires_at);

-- Update RLS for seller_product_stock - Remove admin viewing capability
DROP POLICY IF EXISTS "Admins can manage all stock" ON public.seller_product_stock;

-- Admin can only INSERT (for system operations) but NOT SELECT/VIEW
CREATE POLICY "Admins can insert stock only" ON public.seller_product_stock
FOR INSERT WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Add refresh_count tracking to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS suspicious_refresh_count INTEGER DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS refresh_cooldown_until TIMESTAMP WITH TIME ZONE;