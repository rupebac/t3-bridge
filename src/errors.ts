export class BridgeError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

/** MCP-facing error. Details are limited to codes and counts we set ourselves. */
export function errorResult(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof BridgeError) {
    const details = Object.keys(error.details).length > 0 ? error.details : undefined;
    return details ? { code: error.code, message: error.message, details } : { code: error.code, message: error.message };
  }
  return {
    code: "internal_error",
    message: "The bridge failed unexpectedly. No credentials or remote response bodies are included in this error.",
  };
}

/** Stderr diagnostics. Codes and stack frames only; remote bodies stay out. */
export function logDebug(error: unknown): void {
  if (process.env.T3_BRIDGE_DEBUG !== "1") return;
  const code = error instanceof BridgeError ? error.code : "internal_error";
  const stack = error instanceof Error ? (error.stack ?? "").split("\n").slice(0, 8).join("\n") : "";
  process.stderr.write(`[t3-bridge] ${code}\n${stack}\n`);
}
