import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { authBinding, type Config } from "./config.js";
import { BridgeError } from "./errors.js";
import type { Store } from "./store.js";

const sourceSchema = z.object({
  auth: z.object({
    clientJwt: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    accountId: z.string().min(1).optional(),
  }).optional(),
  privateJwk: z.record(z.string(), z.string()).optional(),
});

/**
 * Copy an account session and DPoP key from a t3code-mcp state directory.
 * The operation journal is left behind, and nothing from the source is returned.
 */
export async function importSession(sourceDir: string, store: Store, config: Config): Promise<{ imported: true; proofKey: "copied" | "missing" }> {
  const path = join(sourceDir, "state.json");
  let file;
  try {
    file = await lstat(path);
  } catch {
    throw new BridgeError("import_incomplete", "No t3code-mcp state file was found to import.");
  }
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new BridgeError("unsafe_state", "The source state must be a regular file.");
  }
  let parsed: z.infer<typeof sourceSchema>;
  try {
    parsed = sourceSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new BridgeError("import_incomplete", "The source state has no account session to import.");
  }
  if (!parsed.auth?.clientJwt) {
    throw new BridgeError("import_incomplete", "The source state has no account session to import.");
  }
  await store.saveSession({
    binding: authBinding(config),
    clientJwt: parsed.auth.clientJwt,
    ...(parsed.auth.sessionId ? { sessionId: parsed.auth.sessionId } : {}),
    ...(parsed.auth.accountId ? { accountId: parsed.auth.accountId } : {}),
  });
  if (parsed.privateJwk) await store.savePrivateJwk(parsed.privateJwk);
  return { imported: true, proofKey: parsed.privateJwk ? "copied" : "missing" };
}
