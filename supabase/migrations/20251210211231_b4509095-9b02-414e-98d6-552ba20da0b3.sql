-- Create tg_marketing table for moderator telegram marketing management
CREATE TABLE public.tg_marketing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_id serial NOT NULL,
  user_id uuid NOT NULL,
  tg_username text NOT NULL,
  used_in uuid DEFAULT NULL,
  reason text DEFAULT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.tg_marketing ENABLE ROW LEVEL SECURITY;

-- Moderators can view all entries
CREATE POLICY "Moderators can view all tg_marketing entries"
ON public.tg_marketing
FOR SELECT
USING (has_role(auth.uid(), 'moderator'::app_role) OR has_role(auth.uid(), 'admin'::app_role));

-- Moderators can insert entries
CREATE POLICY "Moderators can insert tg_marketing entries"
ON public.tg_marketing
FOR INSERT
WITH CHECK (has_role(auth.uid(), 'moderator'::app_role) OR has_role(auth.uid(), 'admin'::app_role));

-- Moderators can update entries
CREATE POLICY "Moderators can update tg_marketing entries"
ON public.tg_marketing
FOR UPDATE
USING (has_role(auth.uid(), 'moderator'::app_role) OR has_role(auth.uid(), 'admin'::app_role));

-- Create index for faster queries
CREATE INDEX idx_tg_marketing_status ON public.tg_marketing(status);
CREATE INDEX idx_tg_marketing_used_in ON public.tg_marketing(used_in);