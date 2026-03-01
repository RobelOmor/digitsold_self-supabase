-- Add security question fields to profiles table
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS security_answer_hash text,
ADD COLUMN IF NOT EXISTS security_answer_set_at timestamptz;

-- Create password change attempts tracking table
CREATE TABLE IF NOT EXISTS public.password_change_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  success boolean DEFAULT false,
  method text -- 'security_question' or 'current_password'
);

-- Enable RLS
ALTER TABLE public.password_change_attempts ENABLE ROW LEVEL SECURITY;

-- Users can only view their own attempts
CREATE POLICY "Users can view own password change attempts" 
ON public.password_change_attempts 
FOR SELECT 
USING (auth.uid() = user_id);

-- Only system can insert (via edge function)
CREATE POLICY "System can insert password change attempts" 
ON public.password_change_attempts 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

-- Create index for efficient monthly counting
CREATE INDEX IF NOT EXISTS idx_password_attempts_user_month 
ON public.password_change_attempts(user_id, created_at);