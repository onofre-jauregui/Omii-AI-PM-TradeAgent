-- Stagger cron schedules to prevent DB connection pool exhaustion.
-- Previously all hourly + */5 + */10 jobs fired simultaneously at :00,
-- causing "remaining connection slots reserved" errors (first hit 2026-05-17).
-- New schedule sequences jobs :01–:10 so no two fire in the same minute.
--
-- Sequence: :01 market-data → :02 auto-settle → :03 surface-scanner →
--           :04 weather-signal → :05 auto-trade → :06 futures-signal →
--           :07 auto-reflect → :08 signal-generator → :10 health-check

SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'market-data-fetcher-cron'),
  schedule := '1,6,11,16,21,26,31,36,41,46,51,56 * * * *'
);
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'surface-scanner-cron'),
  schedule := '3,8,13,18,23,28,33,38,43,48,53,58 * * * *'
);
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'auto-settle-cron'),
  schedule := '2,12,22,32,42,52 * * * *'
);
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'weather-signal-cron'),
  schedule := '4,14,24,34,44,54 * * * *'
);
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'futures-signal-cron'),
  schedule := '6,16,26,36,46,56 * * * *'
);
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'auto-trade-cron'),
  schedule := '5 * * * *'
);
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'auto-reflect-hourly'),
  schedule := '7 * * * *'
);
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'signal-generator-cron'),
  schedule := '8,23,38,53 * * * *'
);
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'health-check-hourly'),
  schedule := '10 * * * *'
);
