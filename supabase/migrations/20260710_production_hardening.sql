-- HITL approvals — pause-and-confirm gate for live trades
CREATE TABLE IF NOT EXISTS hitl_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  trade_payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'timed_out')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  trace_id TEXT
);

CREATE INDEX hitl_approvals_user_id_status_idx ON hitl_approvals(user_id, status);
CREATE INDEX hitl_approvals_requested_at_idx ON hitl_approvals(requested_at DESC);

-- RLS
ALTER TABLE hitl_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own approvals" ON hitl_approvals
  FOR ALL USING (auth.uid() = user_id);
GRANT ALL ON hitl_approvals TO service_role;

-- Failed trade dead-letter queue
CREATE TABLE IF NOT EXISTS failed_trade_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  trade_payload JSONB NOT NULL,
  failure_reason TEXT,
  kalshi_status INT,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retry_count INT NOT NULL DEFAULT 0,
  last_retry_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'failed' CHECK (status IN ('failed', 'replayed', 'abandoned')),
  trace_id TEXT
);

CREATE INDEX failed_trade_queue_user_id_status_idx ON failed_trade_queue(user_id, status);
CREATE INDEX failed_trade_queue_failed_at_idx ON failed_trade_queue(failed_at DESC);

ALTER TABLE failed_trade_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own queue" ON failed_trade_queue
  FOR ALL USING (auth.uid() = user_id);
GRANT ALL ON failed_trade_queue TO service_role;
