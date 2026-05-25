CREATE TABLE IF NOT EXISTS public.rate_limits (
  user_id uuid NOT NULL,
  endpoint text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, endpoint, window_start)
);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only" ON public.rate_limits
  USING (false);

CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup ON public.rate_limits (user_id, endpoint, window_start);

CREATE OR REPLACE FUNCTION public.upsert_rate_limit(
  p_user_id uuid,
  p_endpoint text,
  p_window_start timestamptz,
  p_limit integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  current_count integer;
BEGIN
  INSERT INTO public.rate_limits (user_id, endpoint, window_start, count)
  VALUES (p_user_id, p_endpoint, p_window_start, 1)
  ON CONFLICT (user_id, endpoint, window_start)
  DO UPDATE SET count = rate_limits.count + 1
  RETURNING count INTO current_count;

  RETURN current_count <= p_limit;
END;
$$;
