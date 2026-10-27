import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/bridge.js";
import { BridgeError } from "../src/errors.js";
import { parseBounded, type BoundedView } from "../src/protocol-v2.js";
import { redactFixture } from "../src/redact.js";
import { Store } from "../src/store.js";
import { detailFromRead, decodeThreadCursor, encodeThreadCursor } from "../src/tools/read.js";
import { Mutations } from "../src/tools/mutate.js";
import { selectWatchedRun } from "../src/watch-match.js";
import { Watcher } from "../src/watch.js";

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-r4-"));
  const store = await Store.load(dir);
  await store.saveWebhook({ url: "https://example.test/hooks/t3", secret: "whsec_test" });
  return { dir, store };
}

function bounded(raw: Record<string, unknown>): BoundedView {
  const parsed = parseBounded(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("bounded");
  return parsed.value;
}

function watchTarget(runId: string) {
  return {
    threadId: "thread-1",
    title: "Smoke",
    projectId: "proj-1",
    runId,
    userMessageId: "msg-new",
    baselineRunId: null,
    baselineSet: true,
    allowTerminalRunFallback: true,
  };
}

test("steer resolves when runs have no ordinal and an earlier run is not newer", () => {
  const finished = bounded({
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "idle" },
      runs: [
        { id: "r0", status: "completed", createdAt: "2026-10-25T12:00:00.000Z" },
        { id: "r1", status: "interrupted", createdAt: "2026-10-25T11:00:00.000Z" },
      ],
      visibleTurnItems: [],
    },
  });
  const matched = selectWatchedRun(watchTarget("r1"), finished);
  assert.equal(matched.runId, "r1");
  assert.equal(matched.status, "interrupted");

  const laterInArray = bounded({
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "working", activeRunId: "r2" },
      runs: [
        { id: "r1", status: "interrupted" },
        { id: "r2", status: "running" },
      ],
      visibleTurnItems: [],
    },
  });
  assert.equal(selectWatchedRun(watchTarget("r1"), laterInArray).runId, null);

  const earlierCreatedLater = bounded({
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "idle" },
      runs: [
        { id: "r0", status: "completed", createdAt: "2026-10-25T13:00:00.000Z" },
        { id: "r1", status: "completed" },
      ],
      visibleTurnItems: [],
    },
  });
  assert.equal(selectWatchedRun(watchTarget("r1"), earlierCreatedLater).runId, "r1");
});

test("a steer watch posts the target run when ordinals are missing", async () => {
  const { dir, store } = await tempStore();
  const posts: Array<Record<string, unknown>> = [];
  let current = bounded({
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "working", activeRunId: "r1" },
      runs: [
        { id: "r0", status: "completed" },
        { id: "r1", status: "running" },
      ],
      visibleTurnItems: [],
    },
  });
  const bridge = new Bridge({
    defaultEnvironmentId: "env-1",
    listLinked: async () => ({ environments: [], warnings: [] }),
    probe: async () => "online",
    shell: async () => ({ schemaVersion: null, snapshotSequence: null, projects: [], threads: [], warnings: [] }),
    bounded: async () => current,
    history: async () => ({ snapshotSequence: null, messages: [], historyCursor: null, hasMoreHistory: false, warnings: [] }),
    mutations: new Mutations(store, async () => ({}), async () => ({ id: "r1", status: "running" })),
    watcher: new Watcher(store, async (_url, init) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }),
    store,
  });
  try {
    const ack = await bridge.sendMessage({ operationId: "op-steer", threadId: "thread-1", instructions: "narrow", mode: "steer" });
    assert.equal(ack.runId, "r1");
    current = bounded({
      projection: {
        thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "idle" },
        runs: [
          { id: "r0", status: "completed" },
          { id: "r1", status: "interrupted" },
        ],
        visibleTurnItems: [],
      },
    });
    await bridge.tickWatches();
    assert.equal(posts.length, 0);
    await bridge.tickWatches();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.runId, "r1");
    assert.equal(posts[0]?.status, "interrupted");
    await assert.rejects(
      () => bridge.waitThread({ threadId: "thread-other", operationId: ack.operationId, timeoutSec: 0 }),
      (error: unknown) => error instanceof BridgeError && error.code === "invalid_input",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("redact-text replaces non-structural strings and token prefixes in any mode", () => {
  const secret = "super-secret-token";
  const redacted = redactFixture({
    title: `title ${secret}`,
    command: secret,
    output: secret,
    cwd: "/tmp/work",
    input: { prompt: secret },
    id: "run-1",
    threadId: "thread-1",
    type: "tool_call",
    kind: "command",
    status: "running",
    state: "open",
    createdAt: "2026-10-25T00:00:00.000Z",
    runtimeMode: "approval-required",
    interactionMode: "default",
  }, { redactText: true }) as Record<string, unknown>;
  const dumped = JSON.stringify(redacted);
  assert.equal(dumped.includes(secret), false);
  assert.equal(redacted.id, "run-1");
  assert.equal(redacted.threadId, "thread-1");
  assert.equal(redacted.type, "tool_call");
  assert.equal(redacted.kind, "command");
  assert.equal(redacted.status, "running");
  assert.equal(redacted.state, "open");
  assert.equal(redacted.createdAt, "2026-10-25T00:00:00.000Z");
  assert.equal(redacted.runtimeMode, "approval-required");
  assert.equal(redacted.interactionMode, "default");
  assert.equal(redacted.title, `title ${secret}`.length);
  assert.equal(redacted.command, secret.length);
  assert.equal(redacted.cwd, "/tmp/work".length);

  const tokens = redactFixture({
    note: "sk-live-secret",
    github: "ghp_abcdefghijklmnopqrstuvwxyz",
    slack: "xoxb-123-secret",
    fine: "github_pat_secretvalue",
    title: "kept",
  }) as Record<string, string>;
  assert.equal(tokens.note, "[redacted]");
  assert.equal(tokens.github, "[redacted]");
  assert.equal(tokens.slack, "[redacted]");
  assert.equal(tokens.fine, "[redacted]");
  assert.equal(tokens.title, "kept");
});

test("delivery updates by id do not double-post or restore a purge", async () => {
  const { dir, store } = await tempStore();
  const posts: string[] = [];
  let release = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  const watcher = new Watcher(store, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { eventId?: string };
    posts.push(body.eventId ?? "");
    return new Response(null, { status: 204 });
  }, async () => undefined, () => 5_000);
  try {
    for (let index = 0; index < 3; index += 1) {
      await store.enqueueDelivery({
        id: `d-${index}`,
        event: { event: "t3.run.terminal", eventId: `e-${index}`, runId: `run-${index}` },
        attempts: 3,
        lastError: "http_502",
        nextAttemptAt: new Date(0).toISOString(),
      });
    }
    await watcher.armWatch({
      environmentId: "env-1",
      projectId: null,
      threadId: "thread-1",
      title: null,
      runId: "run-held",
      notifyOnAttention: false,
    });
    let started = () => {};
    const ready = new Promise<void>(resolve => { started = resolve; });
    const tick = watcher.tickWatches(async () => {
      if (!held) {
        held = true;
        started();
        await hold;
      }
      return { runId: null, status: "pending" };
    });
    await ready;
    const replayed = await watcher.replayQueued(true);
    release();
    await tick;
    assert.equal(replayed, 0);
    assert.deepEqual(posts, ["e-0", "e-1", "e-2"]);
    assert.equal((await store.listDeliveries()).length, 0);

    await store.enqueueDelivery({
      id: "keep",
      event: { event: "t3.run.terminal", eventId: "e-keep" },
      attempts: 3,
      lastError: "http_502",
      nextAttemptAt: new Date(0).toISOString(),
    });
    await store.enqueueDelivery({
      id: "drop",
      event: { event: "t3.run.terminal", eventId: "e-drop" },
      attempts: 3,
      lastError: "http_502",
      nextAttemptAt: new Date(0).toISOString(),
    });
    const purging = new Watcher(store, async () => {
      await store.purgeDeliveries("drop");
      return new Response(null, { status: 502 });
    }, async () => undefined, () => 5_000);
    await purging.tickWatches(async () => ({ runId: null, status: "pending" }));
    const left = await store.listDeliveries();
    assert.deepEqual(left.map(entry => entry.id), ["keep"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live leader is the only process that posts queued deliveries", async () => {
  const { dir, store } = await tempStore();
  const posts: string[] = [];
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
  const watcher = new Watcher(store, async (_url, init) => {
    posts.push(String(init?.body));
    return new Response(null, { status: 204 });
  }, async () => undefined, () => 5_000);
  try {
    await store.enqueueDelivery({
      id: "d-1",
      event: { event: "t3.run.terminal", eventId: "e-1" },
      attempts: 3,
      lastError: "transport_error",
      nextAttemptAt: new Date(60_000).toISOString(),
    });
    await writeFile(join(dir, "watcher.lock"), `${child.pid}\n`);
    const replayed = await watcher.replayQueued(true);
    assert.equal(replayed, 0);
    assert.equal(posts.length, 0);
    assert.equal(Date.parse((await store.listDeliveries())[0]?.nextAttemptAt ?? ""), 0);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a backing-off webhook queues the next event and replay sends the oldest first", async () => {
  const { dir, store } = await tempStore();
  let now = 1_000_000;
  const order: string[] = [];
  const watcher = new Watcher(store, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { eventId?: string };
    order.push(body.eventId ?? "");
    return new Response(null, { status: 204 });
  }, async () => undefined, () => now);
  try {
    await store.enqueueDelivery({
      id: "newer",
      event: { event: "t3.run.terminal", eventId: "e-new", runId: "run-new" },
      attempts: 3,
      lastError: "http_502",
      nextAttemptAt: new Date(now + 60_000).toISOString(),
      queuedAt: "2026-10-25T12:00:02.000Z",
    });
    await store.enqueueDelivery({
      id: "older",
      event: { event: "t3.run.terminal", eventId: "e-old", runId: "run-old" },
      attempts: 3,
      lastError: "http_502",
      nextAttemptAt: new Date(now + 30_000).toISOString(),
      queuedAt: "2026-10-25T12:00:01.000Z",
    });
    await watcher.armWatch({
      environmentId: "env-1",
      projectId: null,
      threadId: "thread-1",
      title: null,
      runId: "run-live",
      notifyOnAttention: false,
    });
    await watcher.tickWatches(async () => ({ runId: "run-live", status: "finished", summary: "done" }));
    assert.deepEqual(order, []);
    const queued = await store.listDeliveries();
    assert.equal(queued.length, 3);
    assert.equal(queued.some(entry => entry.lastError === "webhook_backing_off"), true);
    now += 60_000;
    await watcher.tickWatches(async () => ({ runId: null, status: "pending" }));
    assert.deepEqual(order.slice(0, 2), ["e-old", "e-new"]);
    assert.equal(order.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unchanged watch does not rewrite state and the heartbeat is outside it", async () => {
  const { dir, store } = await tempStore();
  let now = 1_700_000_000_000;
  const watcher = new Watcher(store, async () => new Response(null, { status: 204 }), async () => undefined, () => now);
  try {
    await watcher.armWatch({
      environmentId: "env-1",
      projectId: null,
      threadId: "thread-1",
      title: null,
      runId: "run-1",
      notifyOnAttention: false,
    });
    await watcher.tickWatches(async () => ({ runId: "run-1", status: "working" }));
    const first = (await store.listWatches())[0]?.lastCheckedAt;
    now += 10_000;
    await watcher.tickWatches(async () => ({ runId: "run-1", status: "working" }));
    assert.equal((await store.listWatches())[0]?.lastCheckedAt, first);
    const runtime = JSON.parse(await readFile(join(dir, "runtime.json"), "utf8")) as { lastTickAt: string };
    assert.equal(runtime.lastTickAt, new Date(now).toISOString());
    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { runtime?: unknown };
    assert.equal(state.runtime, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("get_thread uses the latest run when the bounded header has no status", () => {
  const parsed = parseBounded({
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Unclear Greeting", status: null },
      runs: [{ id: "run-done", status: "completed", ordinal: 1 }],
      visibleTurnItems: [],
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.thread?.status, null);
  assert.equal(parsed.value.thread?.activityRunStatus, null);
  const detail = detailFromRead("env-1", parsed.value);
  assert.equal(detail.status, "finished");
  assert.equal(detail.run?.status, "finished");

  const empty = parseBounded({
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Unclear Greeting", status: "" },
      runs: [{ id: "run-done", status: "completed", ordinal: 1 }],
      visibleTurnItems: [],
    },
  });
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  assert.equal(detailFromRead("env-1", empty.value).status, "finished");
});

test("bounded pages anchor on the oldest message id", () => {
  const messages = Array.from({ length: 50 }, (_unused, index) => ({
    id: `m${index}`,
    type: "user_message",
    text: "x",
  }));
  const page = (rows: Array<Record<string, unknown>>) => bounded({
    historyCursor: "older-1",
    hasMoreHistory: true,
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Smoke" },
      runs: [],
      visibleTurnItems: rows,
    },
  });
  const view = page(messages);
  const first = detailFromRead("env-1", view, undefined, 20);
  const cursor = decodeThreadCursor(first.historyCursor ?? "");
  assert.equal(cursor?.beforeMessageId, "m30");

  const second = detailFromRead("env-1", page(messages.slice(20)), undefined, 20, cursor);
  assert.deepEqual(second.messages.map(message => message.id), ["m20", "m21", "m22", "m23", "m24", "m25", "m26", "m27", "m28", "m29"]);

  const dropped = page(messages.slice(40));
  const missed = detailFromRead("env-1", dropped, undefined, 20, cursor);
  assert.deepEqual(missed.messages, []);
  assert.equal(missed.warnings.some(warning => warning.includes("beforeMessageId")), true);
  assert.equal(decodeThreadCursor(missed.historyCursor ?? "")?.src, "t3");

  const legacy = detailFromRead("env-1", view, undefined, 20, { src: "bounded", before: 30 });
  assert.equal(legacy.messages[0]?.id, "m10");
  assert.equal(decodeThreadCursor(encodeThreadCursor({ src: "bounded", beforeMessageId: "m30" }))?.beforeMessageId, "m30");
});
