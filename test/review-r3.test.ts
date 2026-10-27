import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/bridge.js";
import { BridgeError } from "../src/errors.js";
import { generateDpopKey, Dpop } from "../src/dpop.js";
import { Http } from "../src/http.js";
import { parseBounded, type BoundedView } from "../src/protocol-v2.js";
import { redactFixture } from "../src/redact.js";
import { fetchBoundedDocument } from "../src/relay-http.js";
import { Store } from "../src/store.js";
import { detailFromRead } from "../src/tools/read.js";
import { Mutations } from "../src/tools/mutate.js";
import { selectWatchedRun } from "../src/watch-match.js";
import { webhookEventId, Watcher } from "../src/watch.js";
import { startFakeV2 } from "./fake-v2.js";

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-r3-"));
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

function idlePrevious(): BoundedView {
  return bounded({
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "idle", activeRunId: null },
      runs: [{ id: "prev", status: "completed", ordinal: 1, userMessageId: "msg-old" }],
      visibleTurnItems: [{ id: "m1", type: "assistant_message", text: "earlier" }],
    },
  });
}

test("wait_thread does not treat the previous finished run as the new prompt", async () => {
  const { dir, store } = await tempStore();
  let phase = 0;
  let messageId = "";
  const before = idlePrevious();
  const bridge = new Bridge({
    defaultEnvironmentId: "env-1",
    listLinked: async () => ({ environments: [], warnings: [] }),
    probe: async () => "online",
    shell: async () => ({ schemaVersion: null, snapshotSequence: null, projects: [], threads: [], warnings: [] }),
    bounded: async () => phase === 0 ? before : bounded({
      projection: {
        thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "idle" },
        runs: [
          { id: "prev", status: "completed", ordinal: 1, userMessageId: "msg-old" },
          { id: "run-new", status: "completed", ordinal: 2, userMessageId: messageId },
        ],
        visibleTurnItems: [{ id: "m2", type: "assistant_message", text: "next" }],
      },
    }),
    history: async () => ({ snapshotSequence: null, messages: [], historyCursor: null, hasMoreHistory: false, warnings: [] }),
    mutations: new Mutations(store, async () => ({})),
    watcher: new Watcher(store, async () => new Response(null, { status: 204 })),
    store,
    sleep: async () => {
      phase = 1;
    },
  });
  try {
    const idle = await bridge.waitThread({ threadId: "thread-1", timeoutSec: 0 });
    assert.equal(idle.timedOut, true);
    assert.equal(idle.runId, null);
    assert.equal(idle.status, "pending");

    const ack = await bridge.sendMessage({ operationId: "op-auto", threadId: "thread-1", instructions: "next", mode: "auto" });
    assert.equal(ack.runId, null);
    assert.equal(typeof ack.userMessageId, "string");
    messageId = ack.userMessageId ?? "";

    const byNullRun = await bridge.waitThread({ threadId: "thread-1", runId: ack.runId, timeoutSec: 0 });
    assert.equal(byNullRun.timedOut, true);
    assert.equal(byNullRun.runId, null);
    assert.equal(byNullRun.status, "pending");

    const early = await bridge.waitThread({ threadId: "thread-1", userMessageId: ack.userMessageId, timeoutSec: 0 });
    assert.equal(early.timedOut, true);
    assert.equal(early.runId, null);

    const waited = await bridge.waitThread({ threadId: "thread-1", userMessageId: ack.userMessageId, timeoutSec: 5 });
    assert.equal(waited.timedOut, false);
    assert.equal(waited.runId, "run-new");
    assert.equal(waited.status, "finished");

    phase = 0;
    const pendingOp = await bridge.waitThread({ threadId: "thread-1", operationId: ack.operationId, timeoutSec: 0 });
    assert.equal(pendingOp.runId, null);
    assert.equal(pendingOp.timedOut, true);
    phase = 1;
    const byOperation = await bridge.waitThread({ threadId: "thread-1", operationId: ack.operationId, timeoutSec: 0 });
    assert.equal(byOperation.runId, "run-new");
    assert.equal(byOperation.status, "finished");
    assert.equal(byOperation.timedOut, false);

    await assert.rejects(
      () => bridge.waitThread({ threadId: "thread-1", operationId: "missing-op", timeoutSec: 0 }),
      (error: unknown) => error instanceof BridgeError && error.code === "operation_not_found",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart watches the new prompt and steer falls back only after one grace tick", async () => {
  const { dir, store } = await tempStore();
  const posts: Array<Record<string, unknown>> = [];
  let current = bounded({
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "working", activeRunId: "r1" },
      runs: [{ id: "r1", status: "running", ordinal: 1, userMessageId: "msg-old" }],
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
    const restarted = await bridge.sendMessage({
      operationId: "op-restart",
      threadId: "thread-1",
      instructions: "again",
      mode: "restart",
    });
    assert.equal(restarted.runId, null);
    assert.equal(typeof restarted.userMessageId, "string");
    const journal = await store.getOperation("op-restart") as { command: { dispatchMode: { type: string; targetRunId: string } } };
    assert.equal(journal.command.dispatchMode.type, "restart_active");
    assert.equal(journal.command.dispatchMode.targetRunId, "r1");
    assert.equal((await store.listWatches())[0]?.runId, null);

    current = bounded({
      projection: {
        thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "idle" },
        runs: [{ id: "r1", status: "interrupted", ordinal: 1, userMessageId: "msg-old" }],
        visibleTurnItems: [],
      },
    });
    await bridge.tickWatches();
    assert.equal(posts.length, 0);

    const messageId = restarted.userMessageId ?? "";
    current = bounded({
      projection: {
        thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "working", activeRunId: "r2" },
        runs: [
          { id: "r1", status: "interrupted", ordinal: 1, userMessageId: "msg-old" },
          { id: "r2", status: "running", ordinal: 2, userMessageId: messageId },
        ],
        visibleTurnItems: [],
      },
    });
    await bridge.tickWatches();
    assert.equal(posts.length, 0);

    current = bounded({
      projection: {
        thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "idle" },
        runs: [
          { id: "r1", status: "interrupted", ordinal: 1, userMessageId: "msg-old" },
          { id: "r2", status: "completed", ordinal: 2, userMessageId: messageId },
        ],
        visibleTurnItems: [{ id: "m2", type: "assistant_message", text: "restarted" }],
      },
    });
    await bridge.tickWatches();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.event, "t3.run.terminal");
    assert.equal(posts[0]?.runId, "r2");
    assert.equal(posts[0]?.status, "finished");
    assert.equal(posts[0]?.eventId, webhookEventId("t3.run.terminal", "r2", "finished"));
    await bridge.unwatchThread({ threadId: "thread-1" });

    posts.length = 0;
    const steered = await bridge.sendMessage({
      operationId: "op-steer",
      threadId: "thread-1",
      instructions: "narrow",
      mode: "steer",
    });
    assert.equal(steered.runId, "r1");
    current = bounded({
      projection: {
        thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "idle" },
        runs: [{ id: "r1", status: "interrupted", ordinal: 1 }],
        visibleTurnItems: [],
      },
    });
    await bridge.tickWatches();
    assert.equal(posts.length, 0);
    await bridge.tickWatches();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.runId, "r1");
    assert.equal(posts[0]?.status, "interrupted");
    await bridge.unwatchThread({ threadId: "thread-1" });

    posts.length = 0;
    const steeredAway = await bridge.sendMessage({
      operationId: "op-steer-new",
      threadId: "thread-1",
      instructions: "replace",
      mode: "steer",
    });
    current = bounded({
      projection: {
        thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "idle" },
        runs: [{ id: "r1", status: "interrupted", ordinal: 1 }],
        visibleTurnItems: [],
      },
    });
    await bridge.tickWatches();
    current = bounded({
      projection: {
        thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "working", activeRunId: "r3" },
        runs: [
          { id: "r1", status: "interrupted", ordinal: 1 },
          { id: "r3", status: "running", ordinal: 3 },
        ],
        visibleTurnItems: [],
      },
    });
    await bridge.tickWatches();
    assert.equal(posts.length, 0);
    current = bounded({
      projection: {
        thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "idle" },
        runs: [
          { id: "r1", status: "interrupted", ordinal: 1 },
          { id: "r3", status: "completed", ordinal: 3, userMessageId: steeredAway.userMessageId },
        ],
        visibleTurnItems: [],
      },
    });
    await bridge.tickWatches();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.runId, "r3");
    assert.equal(posts[0]?.status, "finished");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("request statuses outside the open list do not raise attention", () => {
  const target = {
    threadId: "thread-1",
    title: "Smoke",
    projectId: "proj-1",
    runId: "run-1",
    userMessageId: null,
    baselineRunId: null,
    baselineSet: true,
  };
  for (const status of ["approved", "denied", "answered", "expired"]) {
    const view = bounded({
      projection: {
        thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "working", activeRunId: "run-1" },
        runs: [{ id: "run-1", status: "running", ordinal: 1 }],
        runtimeRequests: [{ id: "req-1", kind: "command", runId: "run-1", status }],
        visibleTurnItems: [],
      },
    });
    assert.equal(selectWatchedRun(target, view).status, "working");
    assert.equal(detailFromRead("env-1", view).pendingRequest, null);
  }
  const open = bounded({
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "working", activeRunId: "run-1" },
      runs: [{ id: "run-1", status: "running", ordinal: 1 }],
      runtimeRequests: [{ id: "req-open", kind: "command", runId: "run-1" }],
      visibleTurnItems: [],
    },
  });
  assert.equal(selectWatchedRun(target, open).status, "awaiting_approval");
  assert.deepEqual(detailFromRead("env-1", open).pendingRequest, { id: "req-open", kind: "command" });
  for (const status of ["pending", "open", "waiting", "requested", "awaiting_input"]) {
    const view = bounded({
      projection: {
        thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "working", activeRunId: "run-1" },
        runs: [{ id: "run-1", status: "running", ordinal: 1 }],
        runtimeRequests: [{ id: "req-open", kind: "user_input", status }],
        visibleTurnItems: [],
      },
    });
    assert.equal(view.runtimeRequests[0]?.pending, true, status);
  }
  const closed = bounded({
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "working", activeRunId: "run-1" },
      runs: [{ id: "run-1", status: "running", ordinal: 1 }],
      runtimeRequests: [{ id: "req-done", kind: "command", resolvedAt: "2026-10-25T12:00:00.000Z" }],
      visibleTurnItems: [],
    },
  });
  assert.equal(closed.runtimeRequests[0]?.pending, false);
});

test("capture keeps raw relay fields and can replace message text with lengths", async () => {
  const { dir, store } = await tempStore();
  const prose = "hello from the workspace";
  const root = "/home/box/rperez";
  const rawBounded = {
    historyCursor: "older-1",
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", futureField: { keep: true } },
      runs: [{ id: "run-1", status: "running", ordinal: 1, triggerMessageId: "trig-1" }],
      runtimeRequests: [{ id: "req-1", kind: "command", requestKind: "approval", secret: "hide-me" }],
      visibleTurnItems: [{ id: "m1", type: "user_message", text: prose }],
    },
  };
  const parsed = parseBounded(rawBounded);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const bridge = new Bridge({
    defaultEnvironmentId: "env-1",
    listLinked: async () => ({ environments: [], warnings: [] }),
    probe: async () => "online",
    shell: async () => ({ schemaVersion: null, snapshotSequence: null, projects: [], threads: [], warnings: [] }),
    bounded: async () => parsed.value,
    history: async () => ({ snapshotSequence: null, messages: [], historyCursor: null, hasMoreHistory: false, warnings: [] }),
    shellDocument: async () => ({
      raw: { projects: [{ id: "proj-1", title: "rperez", workspaceRoot: root, accessToken: "tok" }] },
      view: { schemaVersion: null, snapshotSequence: null, projects: [], threads: [], warnings: [] },
    }),
    boundedDocument: async () => ({ raw: rawBounded, view: parsed.value }),
    historyDocument: async () => ({
      raw: { items: [{ item: { id: "m-old", type: "user_message", text: prose } }], nextCursor: null, extraPage: true },
      view: { snapshotSequence: null, messages: [], historyCursor: null, hasMoreHistory: false, warnings: [] },
    }),
    mutations: new Mutations(store, async () => ({})),
    watcher: new Watcher(store),
    store,
  });
  try {
    const saved = await bridge.captureSnapshot("thread-1", { redactText: true }) as {
      shell: { raw: { projects: Array<{ workspaceRoot: number; accessToken: string }> } };
      bounded: { raw: { projection: { thread: { futureField: { keep: boolean } }; runs: Array<{ triggerMessageId: string }>; runtimeRequests: Array<{ requestKind: string; secret: string }> } }; view: unknown };
      history: { raw: { extraPage: boolean; items: Array<{ item: { text: number } }> } };
    };
    assert.equal(saved.bounded.raw.projection.thread.futureField.keep, true);
    assert.equal(saved.bounded.raw.projection.runs[0]?.triggerMessageId, "trig-1");
    assert.equal(saved.bounded.raw.projection.runtimeRequests[0]?.requestKind, "approval".length);
    assert.equal(saved.bounded.raw.projection.runtimeRequests[0]?.secret, "[redacted]");
    assert.equal(JSON.stringify(saved.bounded.view).includes("triggerMessageId"), false);
    assert.equal(JSON.stringify(saved.bounded.view).includes("futureField"), false);
    assert.equal(JSON.stringify(saved.bounded.view).includes("requestKind"), false);
    assert.equal(saved.shell.raw.projects[0]?.workspaceRoot, root.length);
    assert.equal(saved.shell.raw.projects[0]?.accessToken, "[redacted]");
    assert.equal(saved.history.raw.extraPage, true);
    assert.equal(saved.history.raw.items[0]?.item.text, prose.length);

    const lengths = redactFixture({ text: prose, workspaceRoot: root, title: "kept" }, { redactText: true }) as {
      text: number;
      workspaceRoot: number;
      title: number;
    };
    assert.equal(lengths.text, prose.length);
    assert.equal(lengths.workspaceRoot, root.length);
    assert.equal(lengths.title, "kept".length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fetchBoundedDocument returns the raw JSON beside the parsed view", async () => {
  const fake = await startFakeV2();
  try {
    const document = await fetchBoundedDocument({
      origin: fake.origin,
      accessToken: "env-token",
      signer: new Dpop(generateDpopKey()),
      http: new Http(),
    }, fake.threadId);
    const raw = document.raw as { projection: { thread: { future: boolean }; runs: Array<{ providerState?: { secret: string } }> } };
    assert.equal(raw.projection.thread.future, true);
    assert.equal(raw.projection.runs[0]?.providerState?.secret, "hide");
    assert.equal(JSON.stringify(document.view).includes("providerState"), false);
    assert.equal(JSON.stringify(document.view).includes("future"), false);
  } finally {
    await fake.close();
  }
});

test("webhook event ids are stable and long titles are clipped before save", async () => {
  const first = webhookEventId("t3.run.terminal", "run-1", "finished");
  const second = webhookEventId("t3.run.terminal", "run-1", "finished");
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{32}$/);
  const expired = webhookEventId("t3.watch.expired", "", "expired", "watch-1");
  assert.equal(expired, webhookEventId("t3.watch.expired", "other", "finished", "watch-1"));
  assert.notEqual(expired, webhookEventId("t3.watch.expired", "", "expired", "watch-2"));

  const { dir, store } = await tempStore();
  const title = "T".repeat(600);
  const view = bounded({
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title, status: "working", activeRunId: "run-live" },
      runs: [{ id: "run-live", status: "running", ordinal: 1 }],
      visibleTurnItems: [],
    },
  });
  const posts: Array<Record<string, unknown>> = [];
  const bridge = new Bridge({
    defaultEnvironmentId: "env-1",
    listLinked: async () => ({ environments: [], warnings: [] }),
    probe: async () => "online",
    shell: async () => ({ schemaVersion: null, snapshotSequence: null, projects: [], threads: [], warnings: [] }),
    bounded: async () => view,
    history: async () => ({ snapshotSequence: null, messages: [], historyCursor: null, hasMoreHistory: false, warnings: [] }),
    mutations: new Mutations(store, async () => ({})),
    watcher: new Watcher(store, async (_url, init) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }),
    store,
  });
  try {
    await bridge.watchThread({ threadId: "thread-1" });
    const watch = (await store.listWatches())[0];
    assert.ok(watch);
    assert.ok((watch.title?.length ?? 999) <= 500);
    assert.match(watch.title ?? "", /\[truncated\]$/);

    const expiredWatch = await new Watcher(store).armWatch({
      environmentId: "env-1",
      projectId: "proj-1",
      threadId: "thread-expired",
      title: "gone",
      runId: null,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await bridge.tickWatches();
    const expiry = posts.find(post => post.event === "t3.watch.expired");
    assert.ok(expiry);
    assert.equal(expiry.eventId, webhookEventId("t3.watch.expired", "", "expired", expiredWatch.watchId));
    assert.equal(expiry.watchId, expiredWatch.watchId);

    await store.saveSession({ binding: "binding", clientJwt: "pending-jwt" });
    assert.equal((await bridge.bridgeStatus()).signedIn, false);
    await store.saveSession({ binding: "binding", clientJwt: "pending-jwt", sessionId: "sess-1" });
    assert.equal((await bridge.bridgeStatus()).signedIn, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
