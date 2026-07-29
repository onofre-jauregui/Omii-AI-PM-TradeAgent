/**
 * Lightweight Sentry client for Supabase Deno edge functions.
 * Uses the Sentry Envelope API directly — no SDK dependency, no startup overhead.
 * Fire-and-forget: never throws, never blocks the critical path.
 *
 * DSN is read from SENTRY_DSN env var. If unset, all calls are silent no-ops.
 */

interface SentryExtra {
  [key: string]: unknown;
}

interface SentryContext {
  /** Which edge function this came from */
  function?: string;
  /** Strategy ID if applicable */
  strategyId?: string;
  /** Run/trace ID */
  runId?: string;
  /** Trading mode */
  mode?: string;
  /** Arbitrary key-value context */
  extra?: SentryExtra;
}

type SentryLevel = "fatal" | "error" | "warning" | "info" | "debug";

// send() is fire-and-forget (callers never await it) but the bare `await
// fetch()` inside still held its own connection open indefinitely on a
// stalled Sentry endpoint — same failure shape closed across
// telegram.ts/kalshi-proxy/health-check etc. Under Fluid Compute's reused
// instances, an unresolved fetch here is a dangling connection per
// unreported error until the isolate recycles, not a caller-facing hang.
const SENTRY_FETCH_TIMEOUT_MS = 8_000;

function parseDsn(dsn: string): { host: string; key: string; projectId: string } | null {
  try {
    const url = new URL(dsn);
    const key = url.username;
    const projectId = url.pathname.replace("/", "");
    const host = `${url.protocol}//${url.host}`;
    if (!key || !projectId) return null;
    return { host, key, projectId };
  } catch {
    return null;
  }
}

function buildEnvelope(
  dsn: string,
  eventId: string,
  level: SentryLevel,
  title: string,
  err: Error | null,
  ctx: SentryContext,
): string {
  const parsed = parseDsn(dsn);
  if (!parsed) return "";

  const timestamp = Date.now() / 1000;

  const event: Record<string, unknown> = {
    event_id: eventId,
    timestamp,
    platform: "javascript",
    level,
    logger: ctx.function || "edge-function",
    message: title,
    tags: {
      ...(ctx.function ? { function: ctx.function } : {}),
      ...(ctx.strategyId ? { strategy_id: ctx.strategyId } : {}),
      ...(ctx.mode ? { mode: ctx.mode } : {}),
    },
    extra: {
      ...(ctx.runId ? { run_id: ctx.runId } : {}),
      ...(ctx.extra || {}),
    },
    sdk: {
      name: "sentry.javascript.deno.custom",
      version: "1.0.0",
    },
  };

  if (err) {
    event.exception = {
      values: [
        {
          type: err.name || "Error",
          value: err.message || title,
          stacktrace: err.stack
            ? {
                frames: err.stack
                  .split("\n")
                  .slice(1)
                  .map((line) => {
                    const match = line.match(/at (.+) \((.+):(\d+):(\d+)\)/);
                    if (match) {
                      return {
                        function: match[1],
                        filename: match[2],
                        lineno: parseInt(match[3]),
                        colno: parseInt(match[4]),
                        in_app: !match[2].includes("deno:"),
                      };
                    }
                    return { filename: line.trim() };
                  })
                  .reverse(),
              }
            : undefined,
        },
      ],
    };
  }

  const envelopeHeader = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn });
  const itemHeader = JSON.stringify({ type: "event", content_type: "application/json" });
  const itemBody = JSON.stringify(event);

  return `${envelopeHeader}\n${itemHeader}\n${itemBody}\n`;
}

async function send(dsn: string, envelope: string): Promise<void> {
  const parsed = parseDsn(dsn);
  if (!parsed || !envelope) return;

  const url = `${parsed.host}/api/${parsed.projectId}/envelope/`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SENTRY_FETCH_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${parsed.key}, sentry_client=custom-deno/1.0`,
      },
      body: envelope,
      signal: controller.signal,
    });
  } catch {
    // Never block on observability
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Capture an error with full stack trace.
 */
export function captureException(err: unknown, ctx: SentryContext = {}): void {
  const dsn = Deno.env.get("SENTRY_DSN");
  if (!dsn) return;

  const error = err instanceof Error ? err : new Error(String(err));
  const eventId = crypto.randomUUID().replace(/-/g, "");
  const envelope = buildEnvelope(dsn, eventId, "error", error.message, error, ctx);

  // Fire and forget
  send(dsn, envelope).catch(() => {});
}

/**
 * Capture a message (no stack trace) at the given severity level.
 */
export function captureMessage(
  message: string,
  level: SentryLevel = "info",
  ctx: SentryContext = {},
): void {
  const dsn = Deno.env.get("SENTRY_DSN");
  if (!dsn) return;

  const eventId = crypto.randomUUID().replace(/-/g, "");
  const envelope = buildEnvelope(dsn, eventId, level, message, null, ctx);

  send(dsn, envelope).catch(() => {});
}

/**
 * Wrap an async function in a try/catch that automatically reports to Sentry.
 * Re-throws the error after reporting so callers still see it.
 */
export async function withSentry<T>(
  fn: () => Promise<T>,
  ctx: SentryContext = {},
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    captureException(err, ctx);
    throw err;
  }
}
