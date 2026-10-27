import { z } from "zod";
import { BridgeError } from "./errors.js";
import { VERSION } from "./version.js";

export type FetchLike = typeof fetch;
const MAX_BYTES = 4_000_000;

export class Http {
  constructor(private fetcher: FetchLike = fetch, private timeoutMs = 15_000) {}

  async request<T>(
    url: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
    onHeaders?: (headers: Headers) => Promise<void>,
  ): Promise<{ data: T; headers: Headers }> {
    try {
      const response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json", "user-agent": `t3-bridge/${VERSION}`, ...init.headers },
      });
      if (onHeaders) await onHeaders(response.headers);
      const body = await readBounded(response);
      let data: unknown;
      try {
        data = body ? JSON.parse(body) : undefined;
      } catch {
        data = undefined;
      }
      if (!response.ok) {
        const errors = z.object({
          errors: z.array(z.object({ code: z.string() })).optional(),
          code: z.string().optional(),
        }).safeParse(data);
        const reason = errors.success ? errors.data.errors?.[0]?.code ?? errors.data.code : undefined;
        throw new BridgeError(response.status === 401 ? "auth_required" : "http_error", `Server returned HTTP ${response.status}.`, {
          status: response.status,
          ...(reason && /^[a-z_]{1,80}$/.test(reason) ? { reason } : {}),
        });
      }
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        throw new BridgeError("incompatible_response", "The server response does not match the supported API contract.");
      }
      return { data: parsed.data, headers: response.headers };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("transport_error", "The request failed or timed out.");
    }
  }
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.length;
      if (length > MAX_BYTES) {
        await reader.cancel();
        throw new BridgeError("response_too_large", "The server response exceeded 4 MB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

export function jsonBody(data: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  };
}
