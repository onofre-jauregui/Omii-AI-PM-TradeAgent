-- Waitlist table for /signup landing page
CREATE TABLE IF NOT EXISTS public.waitlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  created_at  timestamptz DEFAULT now()
);

-- Public insert only — anyone can join the waitlist
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "waitlist_insert_public" ON public.waitlist;
CREATE POLICY "waitlist_insert_public"
  ON public.waitlist FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Only service role can read the list
DROP POLICY IF EXISTS "waitlist_select_service_only" ON public.waitlist;
CREATE POLICY "waitlist_select_service_only"
  ON public.waitlist FOR SELECT
  USING (false);
