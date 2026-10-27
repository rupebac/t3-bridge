import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config.js";
import { Store } from "../src/store.js";

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-"));
  const store = await Store.load(dir);
  return { dir, store };
}

test("readConfig honors T3_BRIDGE_STATE_DIR and defaults to menet2", () => {
  const config = readConfig({ T3_BRIDGE_STATE_DIR: "/tmp/bridge-state" } as NodeJS.ProcessEnv);
  assert.equal(config.stateDir, "/tmp/bridge-state");
  assert.equal(config.defaultEnvironmentId, "43972768-c214-40da-acbe-c9ea9a2e3bd4");
  assert.equal(config.clerkOrigin, "https://clerk.t3.codes");
  assert.equal(config.relayOrigin, "https://relay.t3.codes");
});

test("watch CRUD persists with owner-only permissions", async () => {
  const { dir, store } = await tempStore();
  try {
    await store.saveWatch({
      watchId: "w1",
      environmentId: "env-1",
      projectId: "proj-1",
      threadId: "thread-1",
      title: "Greeting",
      runId: "run-1",
      notifyOnAttention: false,
      armedAt: "2026-10-25T11:14:07.100Z",
    });
    await store.saveWatch({
      watchId: "w2",
      environmentId: "env-1",
      projectId: null,
      threadId: "thread-2",
      title: null,
      runId: null,
      notifyOnAttention: true,
      armedAt: "2026-10-25T11:20:00.000Z",
    });
    const watches = await store.listWatches();
    assert.deepEqual(watches.map(watch => watch.watchId), ["w1", "w2"]);
    await store.deleteWatch("w1");
    const reloaded = await Store.load(dir);
    assert.deepEqual((await reloaded.listWatches()).map(watch => watch.watchId), ["w2"]);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "state.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordOperation keeps the original payload for the same operationId", async () => {
  const { dir, store } = await tempStore();
  try {
    const payload = { type: "message.dispatch", commandId: "cmd-1", text: "hi" };
    await store.recordOperation("op-1", payload);
    await store.recordOperation("op-1", payload);
    const reloaded = await Store.load(dir);
    assert.deepEqual(await reloaded.getOperation("op-1"), payload);
    await assert.rejects(
      () => reloaded.recordOperation("op-1", { ...payload, text: "changed" }),
      (error: unknown) => error instanceof Error && /operation_conflict/.test(`${error.message} ${(error as { code?: string }).code ?? ""}`),
    );
    assert.deepEqual(await reloaded.getOperation("op-1"), payload);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session and webhook config survive reload and a newer format is rejected", async () => {
  const { dir, store } = await tempStore();
  try {
    await store.saveSession({ binding: "clerk|relay|t3-relay", clientJwt: "native-client", sessionId: "sess_1", accountId: "user_1" });
    await store.saveWebhook({ url: "https://example.test/hooks/t3", secret: "whsec_test" });
    const reloaded = await Store.load(dir);
    assert.equal((await reloaded.readSession())?.sessionId, "sess_1");
    assert.deepEqual(await reloaded.getWebhookConfig(), { url: "https://example.test/hooks/t3", secret: "whsec_test" });
    const raw = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { version: number };
    assert.equal(raw.version, 1);
    await writeFile(join(dir, "state.json"), JSON.stringify({ version: 99 }), { mode: 0o600 });
    await assert.rejects(
      () => Store.load(dir),
      (error: unknown) => error instanceof Error && /state_too_new/.test(`${error.message} ${(error as { code?: string }).code ?? ""}`),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
