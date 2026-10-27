import { z } from "zod";
import { BridgeError } from "./errors.js";
import { Http } from "./http.js";
import type { RelayEnv } from "./relay-http.js";

const frameSchema = z.object({
  _tag: z.string(),
  requestId: z.union([z.string(), z.number()]).optional(),
  exit: z.object({
    _tag: z.string(),
    value: z.unknown().optional(),
  }).optional(),
});

/** One Effect JSON RPC request per WebSocket. Retries must reuse the journaled payload. */
export function unaryRpc(url: string, method: string, payload: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined;
    let settled = false;
    let received = 0;
    const finish = (error?: BridgeError, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (code: string, message: string) => finish(new BridgeError(code, message));
    const timer = setTimeout(() => fail("transport_error", "The RPC timed out. Retry with the same operationId."), timeoutMs);
    try {
      socket = new WebSocket(url);
    } catch {
      fail("transport_error", "The RPC connection could not be opened.");
      return;
    }
    socket.addEventListener("error", () => fail("transport_error", "The RPC connection failed. Retry with the same operationId."));
    socket.addEventListener("close", () => fail("transport_error", "The RPC connection closed before acceptance was confirmed. Retry with the same operationId."));
    socket.addEventListener("open", () => {
      if (settled || !socket) return;
      socket.send(JSON.stringify({ _tag: "Request", id: "1", tag: method, payload, headers: [] }));
    });
    socket.addEventListener("message", event => {
      if (settled) return;
      const text = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      received += Buffer.byteLength(text);
      if (received > 4_000_000) {
        fail("response_too_large", "The RPC response exceeded 4 MB.");
        return;
      }
      try {
        const decoded: unknown = JSON.parse(text);
        for (const value of Array.isArray(decoded) ? decoded : [decoded]) {
          const message = frameSchema.safeParse(value);
          if (!message.success) continue;
          if (message.data._tag !== "Exit" || String(message.data.requestId ?? "") !== "1" || !message.data.exit) continue;
          if (message.data.exit._tag === "Failure") {
            fail("rpc_error", `T3 rejected the RPC (${safeTag(message.data.exit.value)}). Inspect the thread before retrying with the same operationId.`);
            return;
          }
          if (message.data.exit._tag !== "Success") {
            fail("incompatible_response", "Unexpected RPC exit.");
            return;
          }
          finish(undefined, message.data.exit.value);
          return;
        }
      } catch {
        // Ignore a frame that is not JSON. The request ends on Exit or timeout.
      }
    });
  });
}

function safeTag(value: unknown): string {
  const record = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const candidate = typeof record._tag === "string" ? record._tag
    : typeof record.tag === "string" ? record.tag
    : typeof record.code === "string" ? record.code
    : "Failure";
  return /^[A-Za-z]{1,80}$/.test(candidate) ? candidate : "Failure";
}

const ticketSchema = z.object({ ticket: z.string().min(1) });

/** Ask the environment for a one-shot WebSocket ticket, then run a single v2 RPC. */
export async function environmentRpc(env: RelayEnv & { wsUrl: string }, method: string, payload: Record<string, unknown>): Promise<unknown> {
  const http = env.http ?? new Http();
  const ticketUrl = new URL("/api/auth/websocket-ticket", env.origin.endsWith("/") ? env.origin : `${env.origin}/`);
  const { data } = await http.request(ticketUrl.href, ticketSchema, {
    method: "POST",
    headers: {
      authorization: `DPoP ${env.accessToken}`,
      dpop: env.signer.proof("POST", ticketUrl.href, env.accessToken),
      "x-t3-orchestration-protocol": "2",
    },
  });
  const socketUrl = new URL(env.wsUrl);
  socketUrl.searchParams.set("wsTicket", data.ticket);
  socketUrl.searchParams.set("orchestrationProtocol", "2");
  return unaryRpc(socketUrl.href, method, payload);
}
