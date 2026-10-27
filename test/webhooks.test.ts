import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Bridge } from "../src/bridge.js";
import { BridgeError } from "../src/errors.js";
import { parseBounded, parseShell } from "../src/protocol-v2.js";
import { createServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { Mutations } from "../src/tools/mutate.js";
import { Watcher, type RunSnapshot } from "../src/watch.js";

const secretT3 = "whsec_t3code_value";
const secretHui = "whsec_huivou_value";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "t3-bridge-hooks-"));
}

function finished(watch: { runId: string | null; threadId: string }): RunSnapshot {
  return { runId: watch.runId, status: "finished", summary: "done", threadId: watch.threadId, title: "Smoke", projectId: "proj-1" };
}

test("an old single webhook is read as default and the next save writes the registry", async () => {
  const dir = await tempDir();
  const legacySecret = "whsec_legacy_value";
  await writeFile(join(dir, "state.json"), JSON.stringify({
    version: 1,
    operations: {},
    watches: {
      w1: {
        watchId: "w1",
        environmentId: "env-1",
        projectId: null,
        threadId: "thread-1",
        title: null,
        runId: "run-1",
        notifyOnAttention: false,
        armedAt: "2026-10-25T11:14:07.100Z",
      },
    },
    webhook: { url: "https://example.test/legacy", secret: legacySecret },
  }), { mode: 0o600 });
  try {
    const store = await Store.load(dir);
    assert.deepEqual(await store.listWebhookNames(), ["default"]);
    assert.deepEqual(await store.getWebhook("default"), { url: "https://example.test/legacy", secret: legacySecret });
    assert.deepEqual(await store.getWebhookConfig(), { url: "https://example.test/legacy", secret: legacySecret });
    assert.equal((await store.listWatches())[0]?.wakeTarget, "default");
    const migrated = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { webhook?: unknown; webhooks?: { default?: { secret?: string } } };
    assert.equal(migrated.webhook, undefined);
    assert.equal(migrated.webhooks?.default?.secret, legacySecret);
    await store.saveWebhook({ url: "https://example.test/huivou", secret: secretHui }, "huivou");
    const written = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { webhook?: unknown; webhooks: Record<string, { url: string }> };
    assert.equal(written.webhook, undefined);
    assert.equal(written.webhooks.default?.url, "https://example.test/legacy");
    assert.equal(written.webhooks.huivou?.url, "https://example.test/huivou");
    assert.deepEqual(await store.listWebhookNames(), ["default", "huivou"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("named save, list, and delete never return the secret", async () => {
  const dir = await tempDir();
  const store = await Store.load(dir);
  try {
    await store.saveWebhook({ url: "https://example.test/t3code", secret: secretT3 });
    await store.saveWebhook({ url: "https://example.test/huivou", secret: secretHui }, "huivou");
    const listed = await store.listWebhooks();
    assert.deepEqual(listed, [
      { name: "default", url: "https://example.test/t3code" },
      { name: "huivou", url: "https://example.test/huivou" },
    ]);
    assert.equal(JSON.stringify(listed).includes(secretT3), false);
    assert.equal(JSON.stringify(listed).includes(secretHui), false);
    assert.equal(await store.deleteWebhook("huivou"), true);
    assert.deepEqual(await store.listWebhookNames(), ["default"]);
    assert.equal(await store.deleteWebhook("huivou"), false);
    await assert.rejects(
      async () => store.saveWebhook({ url: "https://example.test/nope", secret: secretT3 }, "Not A Name"),
      (error: unknown) => error instanceof BridgeError && error.code === "invalid_input",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a terminal post goes only to the named wake target", async () => {
  const dir = await tempDir();
  const store = await Store.load(dir);
  const posts: Array<{ url: string; authorization: string; idempotency: string; body: Record<string, unknown> }> = [];
  const watcher = new Watcher(store, async (url, init) => {
    const headers = init?.headers as Record<string, string>;
    posts.push({
      url,
      authorization: headers.authorization ?? "",
      idempotency: headers["idempotency-key"] ?? "",
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(null, { status: 204 });
  });
  try {
    await store.saveWebhook({ url: "https://example.test/t3code", secret: secretT3 }, "t3code");
    await store.saveWebhook({ url: "https://example.test/huivou", secret: secretHui }, "huivou");
    await watcher.armWatch({
      environmentId: "env-1",
      projectId: "proj-1",
      threadId: "thread-a",
      title: "A",
      runId: "run-a",
      notifyOnAttention: false,
      wakeTarget: "t3code",
    });
    await watcher.armWatch({
      environmentId: "env-1",
      projectId: "proj-1",
      threadId: "thread-b",
      title: "B",
      runId: "run-b",
      notifyOnAttention: false,
      wakeTarget: "huivou",
    });
    await watcher.tickWatches(async watch => finished(watch));
    assert.equal(posts.length, 2);
    const byThread = new Map(posts.map(post => [post.body.threadId, post]));
    const t3 = byThread.get("thread-a");
    const hui = byThread.get("thread-b");
    assert.equal(t3?.url, "https://example.test/t3code");
    assert.equal(t3?.authorization, `Bearer ${secretT3}`);
    assert.equal(t3?.body.wakeTarget, "t3code");
    assert.equal(typeof t3?.idempotency, "string");
    assert.equal(t3?.idempotency.length > 0, true);
    assert.equal(hui?.url, "https://example.test/huivou");
    assert.equal(hui?.authorization, `Bearer ${secretHui}`);
    assert.equal(hui?.body.wakeTarget, "huivou");
    assert.equal(posts.some(post => post.url === "https://example.test/t3code" && post.body.threadId === "thread-b"), false);
    assert.equal(posts.some(post => post.url === "https://example.test/huivou" && post.body.threadId === "thread-a"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing wake target is queued and is not posted to another webhook", async () => {
  const dir = await tempDir();
  const store = await Store.load(dir);
  const urls: string[] = [];
  const watcher = new Watcher(store, async url => {
    urls.push(url);
    return new Response(null, { status: 204 });
  });
  try {
    await store.saveWebhook({ url: "https://example.test/t3code", secret: secretT3 }, "t3code");
    await watcher.armWatch({
      environmentId: "env-1",
      projectId: "proj-1",
      threadId: "thread-1",
      title: "Smoke",
      runId: "run-1",
      notifyOnAttention: false,
      wakeTarget: "ghost",
    });
    await watcher.tickWatches(async watch => finished(watch));
    assert.deepEqual(urls, []);
    const queued = await store.listDeliveries();
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.lastError, "webhook_not_configured");
    assert.equal((queued[0]?.event as { wakeTarget?: string }).wakeTarget, "ghost");
    await store.deleteWebhook("t3code");
    await store.saveWebhook({ url: "https://example.test/huivou", secret: secretHui }, "huivou");
    await watcher.armWatch({
      environmentId: "env-1",
      projectId: "proj-1",
      threadId: "thread-2",
      title: "Smoke",
      runId: "run-2",
      notifyOnAttention: false,
      wakeTarget: "huivou",
    });
    await store.deleteWebhook("huivou");
    await store.saveWebhook({ url: "https://example.test/t3code", secret: secretT3 }, "t3code");
    await watcher.tickWatches(async watch => finished(watch));
    assert.deepEqual(urls, []);
    const still = await store.listDeliveries();
    assert.equal(still.some(entry => entry.lastError === "webhook_not_configured" && (entry.event as { wakeTarget?: string }).wakeTarget === "huivou"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function bridgeFor(store: Store, posts: string[] = []) {
  const shell = parseShell({
    projects: [{ id: "proj-1", title: "rperez", workspaceRoot: "/work", defaultModelSelection: { instanceId: "grok", model: "grok-4" } }],
    threads: [],
  });
  assert.equal(shell.ok, true);
  if (!shell.ok) throw new Error("shell");
  const bounded = parseBounded({
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "completed" },
      runs: [{ id: "run-1", ordinal: 1, status: "completed" }],
      visibleTurnItems: [],
    },
    historyCursor: null,
    hasMoreHistory: false,
  });
  assert.equal(bounded.ok, true);
  if (!bounded.ok) throw new Error("bounded");
  const watcher = new Watcher(store, async url => {
    posts.push(url);
    return new Response(null, { status: 204 });
  });
  const bridge = new Bridge({
    defaultEnvironmentId: "env-1",
    listLinked: async () => ({ environments: [], warnings: [] }),
    probe: async () => "online",
    shell: async () => shell.value,
    bounded: async () => bounded.value,
    history: async () => ({ snapshotSequence: null, messages: [], historyCursor: null, hasMoreHistory: false, warnings: [] }),
    mutations: new Mutations(store, async (_environmentId, method, payload) => {
      if (method !== "orchestration.launchThread") return { sequence: 1 };
      const messageId = (payload.initialMessage as { messageId: string }).messageId;
      return { threadId: payload.threadId, projection: { runs: [{ id: "run-new", userMessageId: messageId }] } };
    }),
    watcher,
    store,
  });
  return { bridge, shell: shell.value, bounded: bounded.value };
}

test("wakeTarget defaults to the only registered name, including when it is not default", async () => {
  const dir = await tempDir();
  const store = await Store.load(dir);
  const { bridge } = bridgeFor(store);
  try {
    const none = await store.resolveWakeTarget();
    assert.deepEqual(none, { name: "default" });
    const bare = await bridge.watchThread({ threadId: "thread-1" });
    assert.equal(bare.wakeTarget, "default");
    assert.equal((await store.listWatches())[0]?.wakeTarget, "default");
    await bridge.unwatchThread({ threadId: "thread-1" });
    await store.saveWebhook({ url: "https://example.test/huivou", secret: secretHui }, "huivou");
    const only = await bridge.watchThread({ threadId: "thread-1" });
    assert.equal(only.wakeTarget, "huivou");
    assert.equal((await store.listWatches())[0]?.wakeTarget, "huivou");
    const status = await bridge.bridgeStatus();
    assert.equal(status.webhookConfigured, true);
    assert.deepEqual(status.webhookNames, ["huivou"]);
    assert.equal(JSON.stringify(status).includes(secretHui), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("zero webhooks still arm and queue webhook_not_configured", async () => {
  const dir = await tempDir();
  const store = await Store.load(dir);
  const urls: string[] = [];
  const watcher = new Watcher(store, async url => {
    urls.push(url);
    return new Response(null, { status: 204 });
  });
  const { bridge } = bridgeFor(store);
  try {
    const resolved = await store.resolveWakeTarget();
    assert.deepEqual(resolved, { name: "default" });
    await watcher.armWatch({
      environmentId: "env-1",
      projectId: "proj-1",
      threadId: "thread-1",
      title: "Smoke",
      runId: "run-1",
      notifyOnAttention: false,
      wakeTarget: "name" in resolved ? resolved.name : "default",
    });
    await watcher.tickWatches(async watch => finished(watch));
    assert.deepEqual(urls, []);
    const queued = await store.listDeliveries();
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.lastError, "webhook_not_configured");
    const status = await bridge.bridgeStatus();
    assert.equal(status.webhookConfigured, false);
    assert.deepEqual(status.webhookNames, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("more than one webhook requires wakeTarget and a missing name does not arm", async () => {
  const dir = await tempDir();
  const store = await Store.load(dir);
  const { bridge } = bridgeFor(store);
  try {
    await store.saveWebhook({ url: "https://example.test/t3code", secret: secretT3 }, "t3code");
    await store.saveWebhook({ url: "https://example.test/huivou", secret: secretHui }, "huivou");
    await assert.rejects(
      () => bridge.watchThread({ threadId: "thread-1" }),
      (error: unknown) => error instanceof BridgeError && error.code === "wake_target_required",
    );
    await assert.rejects(
      () => bridge.watchThread({ threadId: "thread-1", wakeTarget: "ghost" }),
      (error: unknown) => error instanceof BridgeError && error.code === "wake_target_missing",
    );
    assert.equal((await store.listWatches()).length, 0);
    const started = await bridge.startThread({
      operationId: "op-1",
      projectId: "proj-1",
      title: "Smoke",
      instructions: "say hi",
    });
    assert.equal(started.accepted, true);
    assert.equal(started.watched, false);
    assert.match(started.warnings?.[0] ?? "", /wake_target_required/);
    const sent = await bridge.sendMessage({
      operationId: "op-2",
      threadId: "thread-1",
      instructions: "follow up",
      wakeTarget: "ghost",
    });
    assert.equal(sent.accepted, true);
    assert.equal(sent.watched, false);
    assert.match(sent.warnings?.[0] ?? "", /wake_target_missing/);
    const chosen = await bridge.sendMessage({
      operationId: "op-3",
      threadId: "thread-1",
      instructions: "follow up again",
      wakeTarget: "huivou",
    });
    assert.equal(chosen.watched, true);
    assert.equal(chosen.warnings, undefined);
    assert.equal((await store.listWatches())[0]?.wakeTarget, "huivou");
    const watches = await bridge.listWatches();
    assert.equal(watches.watches[0]?.wakeTarget, "huivou");
    assert.equal(JSON.stringify(watches).includes(secretHui), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("register_webhook list and delete stay on the MCP tool surface and omit secrets", async () => {
  const dir = await tempDir();
  const store = await Store.load(dir);
  const { bridge } = bridgeFor(store);
  const server = createServer(bridge);
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const tools = await client.listTools();
    for (const name of ["register_webhook", "list_webhooks", "delete_webhook"]) {
      assert.equal(tools.tools.some(tool => tool.name === name), true, name);
    }
    const saved = await client.callTool({
      name: "register_webhook",
      arguments: { name: "t3code", url: "https://example.test/t3code", secret: secretT3 },
    });
    assert.equal(saved.isError, undefined);
    assert.equal(JSON.stringify(saved).includes(secretT3), false);
    assert.deepEqual(saved.structuredContent, { saved: true, name: "t3code" });
    const listed = await client.callTool({ name: "list_webhooks", arguments: {} });
    assert.deepEqual(listed.structuredContent, { webhooks: [{ name: "t3code", url: "https://example.test/t3code" }] });
    assert.equal(JSON.stringify(listed).includes(secretT3), false);
    const removed = await client.callTool({ name: "delete_webhook", arguments: { name: "t3code" } });
    assert.deepEqual(removed.structuredContent, { deleted: true, name: "t3code" });
    assert.deepEqual(await store.listWebhookNames(), []);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
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

test("webhook CLI saves, lists, and deletes by name without printing secrets", async () => {
  const dir = await tempDir();
  const env = { T3_BRIDGE_STATE_DIR: dir };
  try {
    const saved = await cli(["webhook"], env, { url: "http://127.0.0.1:9/t3", secret: secretT3 });
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(saved.stdout.includes(secretT3), false);
    assert.equal(saved.stderr.includes(secretT3), false);
    const named = await cli(["webhook", "--name", "huivou"], env, { url: "https://example.test/huivou", secret: secretHui });
    assert.equal(named.code, 0, named.stderr);
    assert.equal(named.stdout.includes(secretHui), false);
    const listed = await cli(["webhook", "list"], env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.stdout.includes(secretT3), false);
    assert.equal(listed.stdout.includes(secretHui), false);
    assert.deepEqual(JSON.parse(listed.stdout), {
      webhooks: [
        { name: "default", url: "http://127.0.0.1:9/t3" },
        { name: "huivou", url: "https://example.test/huivou" },
      ],
    });
    const removed = await cli(["webhook", "delete", "--name", "huivou"], env);
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(JSON.parse(removed.stdout), { deleted: true, name: "huivou" });
    assert.equal(removed.stdout.includes(secretHui), false);
    const store = await Store.load(dir);
    assert.deepEqual(await store.getWebhook("default"), { url: "http://127.0.0.1:9/t3", secret: secretT3 });
    assert.equal(await store.getWebhook("huivou"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
