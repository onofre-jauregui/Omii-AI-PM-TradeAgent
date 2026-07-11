-- Extend lesson_type allowlist to include stale_signal and kelly_mismatch.
-- These types were already in auto-reflect's validLessonTypes and the LLM prompt
-- but missing from the DB constraint, causing every stale_signal lesson insert
-- to fail with a 23514 check violation and loop indefinitely.
--
-- validLessonTypes in auto-reflect/index.ts is the single source of truth.
-- When adding a new lesson type there, add it here too.

ALTER TABLE trade_lessons DROP CONSTRAINT IF EXISTS trade_lessons_lesson_type_check;
ALTER TABLE trade_lessons ADD CONSTRAINT trade_lessons_lesson_type_check
  CHECK (lesson_type = ANY (ARRAY[
    'forecast_bias'::text,
    'market_timing'::text,
    'stale_signal'::text,
    'kelly_mismatch'::text,
    'signal_quality'::text,
    'execution'::text,
    'market_structure'::text,
    'general'::text
  ]));
