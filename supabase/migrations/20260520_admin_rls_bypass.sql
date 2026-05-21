-- Admin read-bypass policies for observability page
-- Supabase OR-combines policies: admins see all rows, regular users see only theirs (existing policies unchanged)

CREATE POLICY "admin_read_trades" ON public.trades
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
  );

CREATE POLICY "admin_read_compliance_log" ON public.compliance_log
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
  );

CREATE POLICY "admin_read_agent_memory" ON public.agent_memory
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
  );

CREATE POLICY "admin_read_strategies" ON public.strategies
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
  );

CREATE POLICY "admin_read_risk_state" ON public.risk_state
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
  );
