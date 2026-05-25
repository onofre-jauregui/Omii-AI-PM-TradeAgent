CREATE TABLE public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_count INTEGER DEFAULT 0
);
CREATE INDEX idx_conversations_user_id ON public.conversations(user_id, updated_at DESC);
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_conversations" ON public.conversations
  FOR ALL USING (user_id = auth.uid()::text);

CREATE TABLE public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_messages_conversation ON public.chat_messages(conversation_id, created_at ASC);
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_messages" ON public.chat_messages
  FOR ALL USING (user_id = auth.uid()::text);
