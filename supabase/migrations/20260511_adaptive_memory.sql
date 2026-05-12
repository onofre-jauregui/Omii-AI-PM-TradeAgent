-- Adaptive memory: wire lessons → strategy_config
-- Adds excluded_cities[] to strategy_config so auto-reflect can block
-- cities where S-005 has persistent forecast_bias losses.

ALTER TABLE strategy_config
  ADD COLUMN IF NOT EXISTS excluded_cities TEXT[] DEFAULT '{}';

-- DB function to atomically append a city to the exclusion list (no duplicates)
CREATE OR REPLACE FUNCTION append_excluded_city(p_strategy TEXT, p_city TEXT)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE strategy_config
  SET
    excluded_cities = array_append(
      COALESCE(excluded_cities, '{}'),
      p_city
    ),
    updated_at = now()
  WHERE strategy_id = p_strategy
    AND NOT (p_city = ANY(COALESCE(excluded_cities, '{}')));
END;
$$;
