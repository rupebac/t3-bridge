import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { authBinding, readConfig } from "../src/config.js";
import { importSession } from "../src/import-session.js";
import { Store } from "../src/store.js";

const secretJwt = "jwt-secret-value";
const secretKey = "secret-dpop-scalar";

test("import-session rebinds the account and drops the old journal", async () => {
  const source = await mkdtemp(join(tmpdir(), "t3-bridge-src-"));
  const dest = await mkdtemp(join(tmpdir(), "t3-bridge-dst-"));
  const config = readConfig({
    T3_BRIDGE_STATE_DIR: dest,
    T3_BRIDGE_CLERK_ORIGIN: "https://clerk.example",
    T3_BRIDGE_RELAY_ORIGIN: "https://relay.example",
  });
  await writeFile(join(source, "state.json"), JSON.stringify({
    version: 2,
    auth: { binding: "foreign", clientJwt: secretJwt, sessionId: "sess-1", accountId: "acct-1" },
    privateJwk: { kty: "EC", crv: "P-256", d: secretKey, x: "x", y: "y" },
    operations: { "op-old": { payload: { leak: "operation-body" } } },
  }), { mode: 0o600 });
  const store = await Store.load(dest);
  try {
    const imported = await importSession(source, store, config);
    assert.deepEqual(imported, { imported: true, proofKey: "copied" });
    const session = await store.readSession();
    assert.equal(session?.clientJwt, secretJwt);
    assert.equal(session?.sessionId, "sess-1");
    assert.equal(session?.binding, authBinding(config));
    assert.equal(await store.getOperation("op-old"), null);
    assert.equal((await store.readPrivateJwk())?.d, secretKey);
    const stored = await readFile(join(dest, "state.json"), "utf8");
    assert.equal(stored.includes("operation-body"), false);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

function cli(args: string[], env: Record<string, string>, input?: unknown) {
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src/cli.ts"), ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  return once(child, "close").then(([code]) => ({ code, stdout, stderr }));
}

test("webhook and import-session commands do not print secrets", async () => {
  const source = await mkdtemp(join(tmpdir(), "t3-bridge-src-"));
  const dest = await mkdtemp(join(tmpdir(), "t3-bridge-dst-"));
  await writeFile(join(source, "state.json"), JSON.stringify({
    version: 1,
    auth: { binding: "foreign", clientJwt: secretJwt, accountId: "acct-1" },
    privateJwk: { kty: "EC", d: secretKey },
    operations: {},
  }), { mode: 0o600 });
  const env = {
    T3_BRIDGE_STATE_DIR: dest,
    T3_CODE_MCP_STATE_DIR: source,
    T3_BRIDGE_CLERK_ORIGIN: "https://clerk.example",
    T3_BRIDGE_RELAY_ORIGIN: "https://relay.example",
  };
  const secret = "whsec_test_value";
  try {
    const imported = await cli(["import-session"], env);
    assert.equal(imported.code, 0, imported.stderr);
    assert.equal(imported.stdout.includes(secretJwt), false);
    assert.equal(imported.stdout.includes(secretKey), false);
    assert.deepEqual(JSON.parse(imported.stdout), { imported: true, proofKey: "copied" });
    const saved = await cli(["webhook"], env, { url: "http://127.0.0.1:9/hook", secret });
    assert.equal(saved.code, 0, saved.stderr);
    assert.deepEqual(JSON.parse(saved.stdout), { saved: true, name: "default" });
    assert.equal(saved.stdout.includes(secret), false);
    assert.equal(saved.stderr.includes(secret), false);
    const stored = await readFile(join(dest, "state.json"), "utf8");
    assert.equal(stored.includes(secret), true);
    const rejected = await cli(["webhook"], env, { url: "http://example.com/hook", secret });
    assert.equal(rejected.code, 1);
    assert.equal(rejected.stdout.includes(secret), false);
    assert.equal(rejected.stderr.includes(secret), false);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});
