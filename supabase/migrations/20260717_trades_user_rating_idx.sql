-- Index for auto-reflect's user_rating promotion gate — avoids seq scan as trade volume grows.
CREATE INDEX IF NOT EXISTS trades_user_rating_idx ON trades(user_rating)
  WHERE user_rating IS NOT NULL;
