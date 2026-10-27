import { z } from "zod";
import { BridgeError } from "./errors.js";

export const DEFAULT_WEBHOOK_NAME = "default";

/** Short registry key. Agents pass this as wakeTarget. */
export const webhookNameSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9_-]{0,31})?$/);

export function parseWebhookName(name: string): string {
  const parsed = webhookNameSchema.safeParse(name);
  if (!parsed.success) {
    throw new BridgeError(
      "invalid_input",
      "Webhook name must be 1-32 characters: lowercase letters, digits, hyphen, or underscore.",
    );
  }
  return parsed.data;
}

export function webhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BridgeError("invalid_input", "Webhook URL must be HTTPS, or HTTP on loopback.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "https:" || (loopback && url.protocol === "http:")) return url.href;
  throw new BridgeError("invalid_input", "Webhook URL must be HTTPS, or HTTP on loopback.");
}
