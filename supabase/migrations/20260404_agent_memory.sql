-- Agent Memory table for persistent learning across sessions
CREATE TABLE IF NOT EXISTS agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_type TEXT NOT NULL DEFAULT 'lesson'
    CHECK (memory_type IN ('lesson', 'pattern', 'mistake', 'success', 'market_note', 'strategy_insight')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'reflection'
    CHECK (source_type IN ('reflection', 'trade_outcome', 'user_feedback', 'market_observation', 'manual')),
  related_trade_ids UUID[] DEFAULT '{}',
  strategy_id TEXT REFERENCES strategies(id) ON DELETE SET NULL,
  tags TEXT[] DEFAULT '{}',
  confidence NUMERIC NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  confirmations INTEGER NOT NULL DEFAULT 0,
  contradictions INTEGER NOT NULL DEFAULT 0,
  market_context JSONB DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_recalled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_type ON agent_memory(memory_type);
CREATE INDEX IF NOT EXISTS idx_agent_memory_strategy ON agent_memory(strategy_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_tags ON agent_memory USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_agent_memory_active ON agent_memory(is_active, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memory_created ON agent_memory(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memory_user ON agent_memory(user_id);

ALTER TABLE agent_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_memory_select" ON agent_memory;
CREATE POLICY "agent_memory_select" ON agent_memory FOR SELECT USING (user_id IS NULL OR user_id = auth.uid()::text);
DROP POLICY IF EXISTS "agent_memory_insert" ON agent_memory;
CREATE POLICY "agent_memory_insert" ON agent_memory FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "agent_memory_update" ON agent_memory;
CREATE POLICY "agent_memory_update" ON agent_memory FOR UPDATE USING (true);
DROP POLICY IF EXISTS "agent_memory_delete" ON agent_memory;
CREATE POLICY "agent_memory_delete" ON agent_memory FOR DELETE USING (user_id IS NULL OR user_id = auth.uid()::text);

-- Trade reflections table — links trades to their post-hoc analysis
CREATE TABLE IF NOT EXISTS trade_reflections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  expected_outcome TEXT NOT NULL,
  expected_confidence NUMERIC CHECK (expected_confidence >= 0 AND expected_confidence <= 1),
  actual_outcome TEXT,
  actual_pnl NUMERIC,
  analysis TEXT,
  root_cause TEXT,
  lesson_id UUID REFERENCES agent_memory(id) ON DELETE SET NULL,
  decision_quality TEXT CHECK (decision_quality IN ('good', 'acceptable', 'poor', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_trade_reflections_trade ON trade_reflections(trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_reflections_quality ON trade_reflections(decision_quality);
CREATE INDEX IF NOT EXISTS idx_trade_reflections_user ON trade_reflections(user_id);

ALTER TABLE trade_reflections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trade_reflections_select" ON trade_reflections;
CREATE POLICY "trade_reflections_select" ON trade_reflections FOR SELECT USING (user_id IS NULL OR user_id = auth.uid()::text);
DROP POLICY IF EXISTS "trade_reflections_insert" ON trade_reflections;
CREATE POLICY "trade_reflections_insert" ON trade_reflections FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "trade_reflections_update" ON trade_reflections;
CREATE POLICY "trade_reflections_update" ON trade_reflections FOR UPDATE USING (true);
DROP POLICY IF EXISTS "trade_reflections_delete" ON trade_reflections;
CREATE POLICY "trade_reflections_delete" ON trade_reflections FOR DELETE USING (user_id IS NULL OR user_id = auth.uid()::text);
