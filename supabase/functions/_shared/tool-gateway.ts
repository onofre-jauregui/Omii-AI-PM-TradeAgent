/**
 * Tool Gateway — typed wrapper for all agent tool invocations.
 *
 * Every external call from agent code goes through this wrapper:
 *   validate input → call tool → validate output → log (trace_id, tool, timing, cost)
 *
 * This ensures all tool calls are governed, observable, and reconstructable.
 */

export interface GatewayOptions {
  supabase: any;
  userId: string;
  traceId: string;
  toolName: string;
  input: unknown;
  validateInput?: (input: unknown) => string | null; // return error string or null if valid
  validateOutput?: (output: unknown) => string | null;
}

export interface GatewayResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  durationMs: number;
}

export async function gatewayCall<T>(
  opts: GatewayOptions,
  fn: () => Promise<T>
): Promise<GatewayResult<T>> {
  const startMs = Date.now();

  // Input validation
  if (opts.validateInput) {
    const inputError = opts.validateInput(opts.input);
    if (inputError) {
      await logGatewayEvent(opts.supabase, opts.userId, opts.traceId, opts.toolName, "input_validation_failed", {
        error: inputError, input: opts.input,
      });
      return { success: false, error: `Input validation: ${inputError}`, durationMs: Date.now() - startMs };
    }
  }

  let data: T;
  try {
    data = await fn();
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errorMsg = err instanceof Error ? err.message : String(err);
    await logGatewayEvent(opts.supabase, opts.userId, opts.traceId, opts.toolName, "tool_error", {
      error: errorMsg, duration_ms: durationMs,
    });
    return { success: false, error: errorMsg, durationMs };
  }

  const durationMs = Date.now() - startMs;

  // Output validation
  if (opts.validateOutput) {
    const outputError = opts.validateOutput(data);
    if (outputError) {
      await logGatewayEvent(opts.supabase, opts.userId, opts.traceId, opts.toolName, "output_validation_failed", {
        error: outputError, duration_ms: durationMs,
      });
      return { success: false, error: `Output validation: ${outputError}`, durationMs };
    }
  }

  await logGatewayEvent(opts.supabase, opts.userId, opts.traceId, opts.toolName, "tool_success", {
    duration_ms: durationMs,
  });

  return { success: true, data, durationMs };
}

async function logGatewayEvent(
  supabase: any,
  userId: string,
  traceId: string,
  toolName: string,
  eventType: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await supabase.from("compliance_log").insert({
    event_type: `gateway_${eventType}`,
    category: "agent",
    severity: eventType.includes("error") || eventType.includes("failed") ? "warning" : "info",
    message: `[gateway] ${toolName}: ${eventType}`,
    metadata: { tool: toolName, trace_id: traceId, ...metadata },
    user_id: userId || null,
  }).then(null, () => {}); // never let logging block the caller
}
