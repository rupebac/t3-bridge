import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { Bridge, callWithAuthRetry } from "../src/bridge.js";
import { BridgeError } from "../src/errors.js";
import { mapThreadRow, parseBounded, type BoundedView } from "../src/protocol-v2.js";
import { redactFixture } from "../src/redact.js";
import { unaryRpc } from "../src/rpc.js";
import { Store } from "../src/store.js";
import { Mutations } from "../src/tools/mutate.js";
import { decodeThreadCursor, detailFromRead, encodeThreadCursor } from "../src/tools/read.js";
import { selectWatchedRun } from "../src/watch-match.js";
import { Watcher } from "../src/watch.js";

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-r2-"));
  const store = await Store.load(dir);
  await store.saveWebhook({ url: "https://example.test/hooks/t3", secret: "whsec_test" });
  return { dir, store };
}

function bounded(input: {
  status?: string;
  interactionMode?: string;
  hasActionableProposedPlan?: boolean;
  activeRunId?: string | null;
  pendingKind?: string | null;
  runs?: Array<Record<string, unknown>>;
  requests?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
  historyCursor?: string | null;
  hasMoreHistory?: boolean;
}): BoundedView {
  const parsed = parseBounded({
    historyCursor: input.historyCursor ?? null,
    hasMoreHistory: input.hasMoreHistory ?? false,
    projection: {
      thread: {
        id: "thread-1",
        projectId: "proj-1",
        title: "Smoke",
        status: input.status ?? "idle",
        interactionMode: input.interactionMode ?? "default",
        hasActionableProposedPlan: input.hasActionableProposedPlan ?? false,
        activeRunId: input.activeRunId ?? null,
        ...(input.pendingKind ? { pendingRuntimeRequest: { id: "req-header", kind: input.pendingKind } } : {}),
      },
      runs: input.runs ?? [],
      runtimeRequests: input.requests ?? [],
      visibleTurnItems: input.messages ?? [{ id: "m1", type: "assistant_message", text: "done" }],
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("bounded");
  return parsed.value;
}

function bridgeFor(store: Store, current: () => BoundedView, posts: Array<Record<string, unknown>> = [], historyCursor?: { value?: string }) {
  const watcher = new Watcher(store, async (_url, init) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  });
  return new Bridge({
    defaultEnvironmentId: "env-1",
    listLinked: async () => ({ environments: [], warnings: [] }),
    probe: async () => "online",
    shell: async () => ({ schemaVersion: null, snapshotSequence: null, projects: [], threads: [], warnings: [] }),
    bounded: async () => current(),
    history: async (_environmentId, _threadId, cursor) => {
      if (historyCursor) historyCursor.value = cursor;
      return { snapshotSequence: null, messages: [], historyCursor: null, hasMoreHistory: false, warnings: [] };
    },
    mutations: new Mutations(store, async () => ({ sequence: 1 })),
    watcher,
    store,
  });
}

test("watch_thread follows the active run and fires when that run finishes", async () => {
  const { dir, store } = await tempStore();
  const posts: Array<Record<string, unknown>> = [];
  let current = bounded({
    status: "working",
    activeRunId: "run-live",
    runs: [{ id: "run-live", status: "running", ordinal: 3 }, { id: "run-old", status: "completed", ordinal: 1 }],
  });
  const bridge = bridgeFor(store, () => current, posts);
  try {
    await bridge.watchThread({ threadId: "thread-1" });
    const watch = (await store.listWatches())[0];
    assert.equal(watch?.runId, "run-live");
    assert.equal(watch?.baselineRunId, null);
    await bridge.tickWatches();
    assert.equal(posts.length, 0);
    current = bounded({
      status: "idle",
      runs: [{ id: "run-live", status: "completed", ordinal: 3 }, { id: "run-old", status: "completed", ordinal: 1 }],
    });
    await bridge.tickWatches();
    await bridge.tickWatches();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.event, "t3.run.terminal");
    assert.equal(posts[0]?.runId, "run-live");
    assert.equal(posts[0]?.status, "finished");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two prompts on one thread keep two watches", async () => {
  const { dir, store } = await tempStore();
  const bridge = bridgeFor(store, () => bounded({}));
  try {
    const first = await bridge.sendMessage({ operationId: "op-1", threadId: "thread-1", instructions: "one", mode: "queue" });
    const second = await bridge.sendMessage({ operationId: "op-2", threadId: "thread-1", instructions: "two", mode: "queue" });
    assert.equal(first.watched, true);
    assert.equal(second.watched, true);
    assert.equal(first.runId, null);
    const watches = await store.listWatches();
    assert.equal(watches.length, 2);
    assert.equal(new Set(watches.map(watch => watch.userMessageId)).size, 2);
    const removed = await bridge.unwatchThread({ threadId: "thread-1", watchId: watches[0]?.watchId });
    assert.equal(removed.removed, true);
    assert.equal((await store.listWatches()).length, 1);
    assert.equal((await bridge.unwatchThread({ threadId: "thread-1", watchId: "missing" })).removed, false);
    assert.equal((await bridge.unwatchThread({ threadId: "thread-1" })).removed, true);
    assert.equal((await store.listWatches()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an expired watch emits t3.watch.expired and does not block a later terminal", async () => {
  const { dir, store } = await tempStore();
  const posts: Array<Record<string, unknown>> = [];
  let now = Date.parse("2026-10-25T12:00:00.000Z");
  const watcher = new Watcher(store, async (_url, init) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }, async () => undefined, () => now);
  try {
    await watcher.armWatch({
      environmentId: "env-1",
      projectId: "proj-1",
      threadId: "thread-1",
      title: "Smoke",
      runId: "run-1",
      userMessageId: "msg-1",
      notifyOnAttention: false,
      expiresAt: new Date(now + 1_000).toISOString(),
    });
    await watcher.tickWatches(async () => ({ runId: "run-1", status: "working" }));
    assert.equal(posts.length, 0);
    now += 1_500;
    await watcher.tickWatches(async () => ({ runId: "run-1", status: "finished" }));
    assert.equal(posts[0]?.event, "t3.watch.expired");
    assert.equal(await store.hasFired("run-1"), false);
    assert.equal((await store.listWatches()).length, 0);
    await watcher.armWatch({
      environmentId: "env-1",
      projectId: "proj-1",
      threadId: "thread-1",
      title: "Smoke",
      runId: "run-1",
      userMessageId: "msg-1",
      notifyOnAttention: false,
      expiresAt: new Date(now + 86_400_000).toISOString(),
    });
    await watcher.tickWatches(async () => ({ runId: "run-1", status: "finished", summary: "done" }));
    assert.equal(posts.filter(post => post.event === "t3.run.terminal").length, 1);
    assert.equal(posts.at(-1)?.runId, "run-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delivery replay waits, parks client errors, and polls first", async () => {
  const { dir, store } = await tempStore();
  let now = 1_000_000;
  let status = 502;
  let posts = 0;
  const order: string[] = [];
  const watcher = new Watcher(store, async () => {
    posts += 1;
    order.push("post");
    return new Response(null, { status });
  }, async () => undefined, () => now);
  try {
    await watcher.armWatch({
      environmentId: "env-1",
      projectId: null,
      threadId: "thread-1",
      title: null,
      runId: "run-1",
      notifyOnAttention: false,
    });
    await watcher.tickWatches(async () => {
      order.push("poll");
      return { runId: "run-1", status: "failed", summary: "nope" };
    });
    assert.equal(order[0], "poll");
    assert.equal(posts, 3);
    const queued = await store.listDeliveries();
    assert.equal(queued[0]?.parked, false);
    assert.ok(Date.parse(queued[0]?.nextAttemptAt ?? "") > now);
    posts = 0;
    await watcher.tickWatches(async () => ({ runId: null, status: "pending" }));
    assert.equal(posts, 0);
    now += 31_000;
    await watcher.tickWatches(async () => ({ runId: null, status: "pending" }));
    assert.equal(posts, 1);

    status = 401;
    now += 120_000;
    await watcher.tickWatches(async () => ({ runId: null, status: "pending" }));
    assert.equal((await store.listDeliveries())[0]?.parked, true);
    const parkedPosts = posts;
    now += 3_600_000;
    await watcher.tickWatches(async () => ({ runId: null, status: "pending" }));
    assert.equal(posts, parkedPosts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tick replays at most five due deliveries", async () => {
  const { dir, store } = await tempStore();
  let posts = 0;
  const watcher = new Watcher(store, async () => {
    posts += 1;
    return new Response(null, { status: 204 });
  }, async () => undefined, () => 5_000);
  try {
    for (let index = 0; index < 8; index += 1) {
      await store.enqueueDelivery({
        id: `d-${index}`,
        event: { event: "t3.run.terminal", eventId: `e-${index}`, runId: `run-${index}` },
        attempts: 3,
        lastError: "http_502",
        nextAttemptAt: new Date(0).toISOString(),
      });
    }
    await watcher.tickWatches(async () => ({ runId: null, status: "pending" }));
    assert.equal(posts, 5);
    assert.equal((await store.listDeliveries()).length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pending runtime requests raise attention on a non-terminal run", () => {
  const view = bounded({
    status: "working",
    activeRunId: null,
    runs: [{ id: "run-1", status: "running", ordinal: 2, userMessageId: "msg-1" }],
    requests: [{ id: "req-1", kind: "command", runId: "run-1" }],
  });
  const matched = selectWatchedRun({
    threadId: "thread-1",
    title: "Smoke",
    projectId: "proj-1",
    runId: null,
    userMessageId: "msg-1",
    baselineRunId: null,
    baselineSet: true,
  }, view);
  assert.equal(matched.status, "awaiting_approval");
  assert.equal(matched.attentionKind, "command");
  assert.equal(matched.runId, "run-1");

  const resolved = bounded({
    status: "working",
    runs: [{ id: "run-1", status: "running", ordinal: 1 }],
    requests: [{ id: "req-2", kind: "command", resolved: true }],
  });
  const quiet = selectWatchedRun({
    threadId: "thread-1",
    title: null,
    projectId: null,
    runId: "run-1",
    userMessageId: null,
    baselineRunId: null,
    baselineSet: true,
  }, resolved);
  assert.equal(quiet.status, "working");

  const planned = bounded({
    status: "idle",
    interactionMode: "plan",
    hasActionableProposedPlan: true,
    runs: [{ id: "run-plan", status: "completed", ordinal: 1, userMessageId: "msg-plan" }],
  });
  const plan = selectWatchedRun({
    threadId: "thread-1",
    title: null,
    projectId: null,
    runId: null,
    userMessageId: "msg-plan",
    baselineRunId: null,
    baselineSet: true,
  }, planned);
  assert.equal(plan.status, "finished");
  assert.equal(plan.planReady, true);
});

test("get_thread cursors page the bounded transcript without skipping", () => {
  const messages = Array.from({ length: 50 }, (_unused, index) => ({
    id: `m${index}`,
    type: "user_message",
    text: "x",
  }));
  const view = bounded({ messages, historyCursor: "older-1", hasMoreHistory: true });
  const first = detailFromRead("env-1", view, undefined, 20);
  assert.deepEqual(first.messages.map(message => message.id), Array.from({ length: 20 }, (_unused, index) => `m${index + 30}`));
  const firstCursor = decodeThreadCursor(first.historyCursor ?? "");
  assert.equal(firstCursor?.src, "bounded");
  assert.equal(firstCursor?.beforeMessageId, "m30");
  assert.equal(first.historyCursor?.startsWith("tb1."), true);

  const second = detailFromRead("env-1", view, undefined, 20, firstCursor);
  assert.deepEqual(second.messages.map(message => message.id), Array.from({ length: 20 }, (_unused, index) => `m${index + 10}`));
  const secondCursor = decodeThreadCursor(second.historyCursor ?? "");
  assert.equal(secondCursor?.beforeMessageId, "m10");

  const third = detailFromRead("env-1", view, undefined, 20, secondCursor);
  assert.deepEqual(third.messages.map(message => message.id), Array.from({ length: 10 }, (_unused, index) => `m${index}`));
  const thirdCursor = decodeThreadCursor(third.historyCursor ?? "");
  assert.equal(thirdCursor?.src, "t3");
  assert.equal(thirdCursor?.cursor, "older-1");

  const history = detailFromRead("env-1", view, {
    snapshotSequence: null,
    messages: [
      { id: "h0", role: "user", text: "old-0" },
      { id: "h1", role: "user", text: "old-1" },
    ],
    historyCursor: "older-2",
    hasMoreHistory: true,
    warnings: [],
  }, 1, thirdCursor);
  assert.deepEqual(history.messages.map(message => message.id), ["h1"]);
  const again = decodeThreadCursor(history.historyCursor ?? "");
  assert.equal(again?.src, "t3");
  assert.equal(again?.cursor, "older-1");
  assert.equal(again?.beforeMessageId, "h1");
  assert.equal(encodeThreadCursor({ src: "bounded", before: 30 }).includes("m30"), false);
});

test("loose run rows, null titles, and steer run ids survive", async () => {
  const parsed = parseBounded({
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: null },
      runs: [{ id: "run-3", ordinal: "3", status: "" }],
      visibleTurnItems: [{ id: "big", type: "assistant_message", text: "z".repeat(250_000) }],
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.thread?.title, "");
  assert.equal(parsed.value.runs[0]?.ordinal, 3);
  assert.equal(parsed.value.runs[0]?.status, "unknown");
  assert.ok((parsed.value.messages[0]?.text.length ?? 0) <= 200_000);
  assert.equal(mapThreadRow({ id: "thread-1", projectId: "proj-1", title: null })?.title, "");

  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-steer-"));
  const store = await Store.load(dir);
  const seen: string[] = [];
  const mutations = new Mutations(store, async (environmentId) => {
    seen.push(environmentId);
    return {};
  }, async (environmentId) => {
    seen.push(`active:${environmentId}`);
    return { id: "run-active", status: "running" };
  });
  try {
    const steered = await mutations.sendFollowUp({
      operationId: "op-steer",
      environmentId: "env-a",
      threadId: "thread-1",
      instructions: "narrow",
      mode: "steer",
    });
    const queued = await mutations.sendFollowUp({
      operationId: "op-queue",
      environmentId: "env-b",
      threadId: "thread-1",
      instructions: "later",
      mode: "queue",
    });
    assert.equal(steered.runId, "run-active");
    assert.equal(queued.runId, null);
    assert.deepEqual(seen, ["active:env-a", "env-a", "env-b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watch_thread rejects a missing thread and wait_thread returns a finished run immediately", async () => {
  const { dir, store } = await tempStore();
  let current = bounded({ runs: [] });
  current = { ...current, thread: null };
  const bridge = bridgeFor(store, () => current);
  try {
    await assert.rejects(() => bridge.watchThread({ threadId: "thread-1" }), (error: { code?: string }) => error.code === "thread_not_found");
    assert.equal((await store.listWatches()).length, 0);
    current = bounded({
      status: "idle",
      runs: [{ id: "run-done", status: "completed", ordinal: 1 }],
    });
    const started = Date.now();
    const waited = await bridge.waitThread({ threadId: "thread-1", runId: "run-done", timeoutSec: 20 });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.status, "finished");
    assert.equal(waited.runId, "run-done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("auth retry runs once and a 401 drops the cached credential hook", async () => {
  let calls = 0;
  let drops = 0;
  const value = await callWithAuthRetry(async () => {
    calls += 1;
    if (calls === 1) throw new BridgeError("auth_required", "Server returned HTTP 401.");
    return "ok";
  }, () => { drops += 1; });
  assert.equal(value, "ok");
  assert.equal(drops, 1);
  await assert.rejects(() => callWithAuthRetry(async () => {
    throw new BridgeError("auth_required", "Server returned HTTP 401.");
  }, () => { drops += 1; }), (error: { code?: string }) => error.code === "auth_required");
  assert.equal(drops, 2);
});

test("locks treat our pid as ours and a fresh empty lock as held", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-lock-r2-"));
  const store = await Store.load(dir);
  try {
    await writeFile(join(dir, "watcher.lock"), `${process.pid}\n`);
    assert.equal(await store.tryAcquireWatcher(), true);
    store.releaseWatcherSync();

    const lock = join(dir, "state.lock");
    await writeFile(lock, "\n");
    const old = new Date(Date.now() - 30_000);
    await utimes(lock, old, old);
    const started = Date.now();
    await store.saveSession({ binding: "binding", clientJwt: "jwt" });
    assert.ok(Date.now() - started < 2_000);

    await writeFile(lock, "\n");
    let done = false;
    const pending = store.saveWebhook({ url: "https://example.test/hooks/t3", secret: "whsec_test" }).then(() => {
      done = true;
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(done, false);
    await rm(lock, { force: true });
    await pending;
    assert.equal(done, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("operations older than seven days are pruned on the next write", async () => {
  const { dir, store } = await tempStore();
  try {
    await store.recordOperation("op-old", { text: "keep" });
    const raw = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as {
      operations: Record<string, { savedAt?: string }>;
    };
    raw.operations["op-old"]!.savedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(join(dir, "state.json"), JSON.stringify(raw));
    await store.saveWebhook({ url: "https://example.test/hooks/other", secret: "whsec_next" });
    assert.equal(await store.getOperation("op-old"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unary RPC ignores junk frames and hides failure bodies", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on("message", () => {
        ws.send("not-json");
        ws.send(JSON.stringify({ _tag: "Ping", requestId: "9" }));
        ws.send(JSON.stringify({
          _tag: "Exit",
          requestId: "1",
          exit: { _tag: "Failure", value: { message: "SECRET upstream", code: "Rejected!" } },
        }));
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(
      () => unaryRpc(`ws://127.0.0.1:${port}`, "orchestration.dispatchCommand", { commandId: "c1" }),
      (error: { code?: string; message?: string }) => error.code === "rpc_error"
        && !String(error.message).includes("SECRET")
        && String(error.message).includes("Failure"),
    );
  } finally {
    wss.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("redaction and the deliveries list omit secrets", async () => {
  const redacted = redactFixture({
    access_token: "secret-token",
    nested: { authorization: "Bearer secret" },
    note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturevalue",
    title: "kept",
  }) as { access_token: string; nested: { authorization: string }; note: string; title: string };
  assert.equal(redacted.access_token, "[redacted]");
  assert.equal(redacted.nested.authorization, "[redacted]");
  assert.equal(redacted.note, "[redacted]");
  assert.equal(redacted.title, "kept");

  const { dir, store } = await tempStore();
  try {
    await store.enqueueDelivery({
      id: "delivery-1",
      event: { event: "t3.run.terminal", threadId: "thread-1", runId: "run-1" },
      attempts: 1,
      lastError: "http_502",
    });
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src/cli.ts"), "deliveries", "list"], {
      env: { ...process.env, T3_BRIDGE_STATE_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    assert.equal(stdout.includes("whsec_test"), false);
    assert.equal(stdout.includes("delivery-1"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("get_thread hands the upstream cursor to history, not the opaque wrapper", async () => {
  const { dir, store } = await tempStore();
  const seen: string[] = [];
  const view = bounded({
    messages: Array.from({ length: 5 }, (_unused, index) => ({ id: `m${index}`, type: "user_message", text: "x" })),
    historyCursor: "older-1",
    hasMoreHistory: true,
  });
  const bridge = new Bridge({
    defaultEnvironmentId: "env-1",
    listLinked: async () => ({ environments: [], warnings: [] }),
    probe: async () => "online",
    shell: async () => ({ schemaVersion: null, snapshotSequence: null, projects: [], threads: [], warnings: [] }),
    bounded: async () => view,
    history: async (_environmentId, _threadId, cursor) => {
      seen.push(cursor ?? "");
      return {
        snapshotSequence: null,
        messages: [{ id: "old", role: "user", text: "earlier" }],
        historyCursor: null,
        hasMoreHistory: false,
        warnings: [],
      };
    },
    mutations: new Mutations(store, async () => ({})),
    watcher: new Watcher(store),
    store,
  });
  try {
    const page = await bridge.getThread({ threadId: "thread-1", limit: 2 });
    assert.equal(seen.length, 0);
    assert.equal(page.messages.at(-1)?.id, "m4");
    let cursor = page.historyCursor;
    for (let step = 0; step < 5 && decodeThreadCursor(cursor ?? "")?.src === "bounded"; step += 1) {
      const next = await bridge.getThread({ threadId: "thread-1", beforeCursor: cursor ?? "", limit: 2 });
      cursor = next.historyCursor;
    }
    assert.equal(decodeThreadCursor(cursor ?? "")?.src, "t3");
    assert.equal(decodeThreadCursor(cursor ?? "")?.cursor, "older-1");
    await bridge.getThread({ threadId: "thread-1", beforeCursor: cursor ?? "" });
    assert.deepEqual(seen, ["older-1"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
