const SECRET_KEYS = new Set([
  "authorization",
  "access_token",
  "accessToken",
  "refresh_token",
  "token",
  "secret",
  "credential",
  "clientJwt",
  "privateJwk",
  "dpop",
  "password",
  "cookie",
  "wsTicket",
  "ticket",
]);

const STRUCTURAL_KEYS = new Set(["id", "type", "kind", "status", "state", "runtimeMode", "interactionMode"]);

/** Strip credential-shaped fields before a fixture is written to disk. */
export function redactFixture(value: unknown, options?: { redactText?: boolean }): unknown {
  return walk(value, options?.redactText === true);
}

function walk(value: unknown, redactText: boolean, key?: string): unknown {
  if (Array.isArray(value)) return value.map(item => walk(item, redactText));
  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [childKey, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(childKey)) {
        redacted[childKey] = "[redacted]";
        continue;
      }
      redacted[childKey] = walk(entry, redactText, childKey);
    }
    return redacted;
  }
  if (typeof value === "string" && (looksLikeJwt(value) || looksLikeToken(value))) return "[redacted]";
  if (redactText && typeof value === "string" && !isStructuralKey(key)) return value.length;
  return value;
}

function isStructuralKey(key: string | undefined): boolean {
  if (!key) return false;
  if (STRUCTURAL_KEYS.has(key)) return true;
  return key.endsWith("Id") || key.endsWith("At");
}

function looksLikeToken(value: string): boolean {
  return value.startsWith("sk-") || value.startsWith("ghp_") || value.startsWith("github_pat_") || value.startsWith("xox");
}

function looksLikeJwt(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every(part => part.length > 8);
}
