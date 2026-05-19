const LANGFUSE_HOST = Deno.env.get("LANGFUSE_HOST") ?? "https://cloud.langfuse.com";
const PUBLIC_KEY = Deno.env.get("LANGFUSE_PUBLIC_KEY") ?? "";
const SECRET_KEY = Deno.env.get("LANGFUSE_SECRET_KEY") ?? "";

function authHeader(): string {
  return "Basic " + btoa(`${PUBLIC_KEY}:${SECRET_KEY}`);
}

// Strip OpenRouter provider prefix so Langfuse can match model pricing.
// "openai/gpt-4o-mini" → "gpt-4o-mini", "anthropic/claude-3-5-sonnet" → "claude-3-5-sonnet"
function normalizeModel(model: string): string {
  return model.includes("/") ? model.split("/").slice(1).join("/") : model;
}

// Fire-and-forget batch ingestion. Never throws — observability must not block trades.
export function langfuseIngest(events: object[]): void {
  if (!PUBLIC_KEY || !SECRET_KEY) return;

  fetch(`${LANGFUSE_HOST}/api/public/ingestion`, {
    method: "POST",
    headers: {
      "Authorization": authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ batch: events }),
  }).catch(() => {});
}

export function traceEvent(traceId: string, name: string, meta: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    type: "trace-create",
    timestamp: new Date().toISOString(),
    body: { id: traceId, name, metadata: meta },
  };
}

export function generationEvent(opts: {
  traceId: string;
  name: string;
  model: string;
  prompt: string;
  completion: string;
  startTime: string;
  endTime: string;
  inputTokens?: number;
  outputTokens?: number;
  metadata?: Record<string, unknown>;
}) {
  return {
    id: crypto.randomUUID(),
    type: "observation-create",          // was "generation-create" — not a valid Langfuse type
    timestamp: new Date().toISOString(),
    body: {
      id: crypto.randomUUID(),           // observation needs its own id
      traceId: opts.traceId,
      type: "GENERATION",               // required to classify as a generation observation
      name: opts.name,
      model: normalizeModel(opts.model), // strip "openai/" prefix for cost lookup
      startTime: opts.startTime,
      endTime: opts.endTime,
      input: [{ role: "user", content: opts.prompt }],
      output: opts.completion,
      usage: opts.inputTokens != null
        ? {
            input: opts.inputTokens,
            output: opts.outputTokens ?? 0,
            unit: "TOKENS",             // required for Langfuse cost calculation
          }
        : undefined,
      metadata: opts.metadata,
    },
  };
}

// Emit after a trade settles — 1=correct qualify (pnl > 0), 0=wrong qualify (pnl <= 0)
export function scoreEvent(traceId: string, name: string, value: number, comment?: string) {
  return {
    id: crypto.randomUUID(),
    type: "score-create",
    timestamp: new Date().toISOString(),
    body: {
      traceId,
      name,
      value,
      dataType: "NUMERIC",             // explicit type prevents ambiguous score warnings
      comment,
    },
  };
}
