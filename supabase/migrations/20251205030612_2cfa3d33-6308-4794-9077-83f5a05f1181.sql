-- Create order_chats table for chat rooms
CREATE TABLE public.order_chats (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.seller_orders(id) ON DELETE CASCADE,
  buyer_id UUID NOT NULL,
  seller_id UUID NOT NULL,
  moderator_id UUID,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'delivered', 'completed', 'disputed')),
  delivery_marked_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(order_id)
);

-- Create chat_messages table
CREATE TABLE public.chat_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_id UUID NOT NULL REFERENCES public.order_chats(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('buyer', 'seller', 'moderator', 'system')),
  message TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'delivery_mark', 'completed', 'moderator_joined', 'system')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.order_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- RLS policies for order_chats
CREATE POLICY "Users can view their own chats"
  ON public.order_chats FOR SELECT
  USING (auth.uid() = buyer_id OR auth.uid() IN (SELECT user_id FROM seller_profiles WHERE id = seller_id) OR auth.uid() = moderator_id OR public.has_role(auth.uid(), 'moderator') OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Buyers can create chats for their orders"
  ON public.order_chats FOR INSERT
  WITH CHECK (auth.uid() = buyer_id);

CREATE POLICY "Participants can update chats"
  ON public.order_chats FOR UPDATE
  USING (auth.uid() = buyer_id OR auth.uid() IN (SELECT user_id FROM seller_profiles WHERE id = seller_id) OR auth.uid() = moderator_id OR public.has_role(auth.uid(), 'moderator'));

-- RLS policies for chat_messages
CREATE POLICY "Chat participants can view messages"
  ON public.chat_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.order_chats oc 
      WHERE oc.id = chat_id 
      AND (auth.uid() = oc.buyer_id OR auth.uid() IN (SELECT user_id FROM seller_profiles WHERE id = oc.seller_id) OR auth.uid() = oc.moderator_id OR public.has_role(auth.uid(), 'moderator') OR public.has_role(auth.uid(), 'admin'))
    )
  );

CREATE POLICY "Chat participants can send messages"
  ON public.chat_messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id AND
    EXISTS (
      SELECT 1 FROM public.order_chats oc 
      WHERE oc.id = chat_id 
      AND (auth.uid() = oc.buyer_id OR auth.uid() IN (SELECT user_id FROM seller_profiles WHERE id = oc.seller_id) OR auth.uid() = oc.moderator_id OR public.has_role(auth.uid(), 'moderator'))
    )
  );

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
ALTER TABLE public.chat_messages REPLICA IDENTITY FULL;

-- Create indexes
CREATE INDEX idx_order_chats_order_id ON public.order_chats(order_id);
CREATE INDEX idx_order_chats_buyer_id ON public.order_chats(buyer_id);
CREATE INDEX idx_order_chats_seller_id ON public.order_chats(seller_id);
CREATE INDEX idx_chat_messages_chat_id ON public.chat_messages(chat_id);
CREATE INDEX idx_chat_messages_created_at ON public.chat_messages(created_at);

-- Trigger for updated_at
CREATE TRIGGER update_order_chats_updated_at
  BEFORE UPDATE ON public.order_chats
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();