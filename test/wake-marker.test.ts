import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/bridge.js";
import { parseBounded, type BoundedView } from "../src/protocol-v2.js";
import { Store } from "../src/store.js";
import { Mutations, WAKE_MARKER_PATTERN, wakeMarker, withWakeMarker } from "../src/tools/mutate.js";
import { Watcher } from "../src/watch.js";

const hookRegex = /\[t3b-wake target=(\S+) thread=(\S+) op=(\S+)\]/;

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-wake-"));
  const store = await Store.load(dir);
  await store.saveWebhook({ url: "https://example.test/hooks/huivou", secret: "whsec_test" }, "huivou");
  return { dir, store };
}

function lastLine(text: string): string {
  return text.split("\n").at(-1) ?? "";
}

function captureRpc() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const rpc = async (_environmentId: string, method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    if (method === "orchestration.launchThread") {
      const messageId = (payload.initialMessage as { messageId: string }).messageId;
      return { threadId: payload.threadId, projection: { thread: { id: payload.threadId }, runs: [{ id: "run-new", status: "running", userMessageId: messageId, ordinal: 1 }] } };
    }
    return { sequence: 1 };
  };
  return { calls, rpc };
}

test("wakeMarker has the exact hook format and matches the hook regex", () => {
  const line = wakeMarker("huivou", "thread-1", "op-1");
  assert.equal(line, "[t3b-wake target=huivou thread=thread-1 op=op-1]");
  assert.deepEqual(hookRegex.exec(line)?.slice(1), ["huivou", "thread-1", "op-1"]);
  assert.equal(String(WAKE_MARKER_PATTERN), String(hookRegex));
  assert.equal(withWakeMarker("hello", undefined, "thread-1", "op-1"), "hello");
  assert.equal(withWakeMarker("hello\n", "huivou", "t", "o"), "hello\n\n[t3b-wake target=huivou thread=t op=o]");
});

test("start_thread appends the marker with the minted threadId and the operationId", async () => {
  const { dir, store } = await tempStore();
  const { calls, rpc } = captureRpc();
  const mutations = new Mutations(store, rpc);
  try {
    const ack = await mutations.launchThread({
      operationId: "op-launch",
      environmentId: "env-1",
      projectId: "proj-1",
      title: "Smoke",
      instructions: "say hi\nthen stop",
      modelSelection: { instanceId: "claude", model: "opus" },
      wakeTarget: "huivou",
    });
    const payload = calls[0]!.payload;
    const text = (payload.initialMessage as { text: string }).text;
    assert.equal(text, `say hi\nthen stop\n[t3b-wake target=huivou thread=${String(payload.threadId)} op=op-launch]`);
    assert.equal(ack.threadId, payload.threadId);
    const match = hookRegex.exec(lastLine(text));
    assert.deepEqual(match?.slice(1), ["huivou", ack.threadId, "op-launch"]);

    // Retry replays the journal: same thread id and same marker.
    await mutations.launchThread({
      operationId: "op-launch",
      environmentId: "env-1",
      projectId: "proj-1",
      title: "Smoke",
      instructions: "say hi\nthen stop",
      modelSelection: { instanceId: "claude", model: "opus" },
      wakeTarget: "huivou",
    });
    assert.equal((calls[1]!.payload.initialMessage as { text: string }).text, text);
    // A different wakeTarget under the same operationId is a conflict.
    await assert.rejects(() => mutations.launchThread({
      operationId: "op-launch",
      environmentId: "env-1",
      projectId: "proj-1",
      title: "Smoke",
      instructions: "say hi\nthen stop",
      modelSelection: { instanceId: "claude", model: "opus" },
      wakeTarget: "other",
    }), (error: { code?: string }) => error.code === "operation_conflict");

    await mutations.launchThread({
      operationId: "op-plain",
      environmentId: "env-1",
      projectId: "proj-1",
      title: "Plain",
      instructions: "no wake",
      modelSelection: { instanceId: "claude", model: "opus" },
    });
    assert.equal((calls.at(-1)!.payload.initialMessage as { text: string }).text, "no wake");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("send_message appends the marker for auto, queue, steer, and restart", async () => {
  const { dir, store } = await tempStore();
  const { calls, rpc } = captureRpc();
  const mutations = new Mutations(store, rpc, async () => ({ id: "run-active", status: "running" }));
  try {
    for (const mode of ["auto", "queue", "steer", "restart"] as const) {
      await mutations.sendFollowUp({
        operationId: `op-${mode}`,
        environmentId: "env-1",
        threadId: "thread-9",
        instructions: `do ${mode}`,
        mode,
        wakeTarget: "huivou",
      });
      const dispatches = calls.filter(call => call.payload.type === "message.dispatch");
      const text = String(dispatches.at(-1)!.payload.text);
      assert.equal(text, `do ${mode}\n[t3b-wake target=huivou thread=thread-9 op=op-${mode}]`);
    }
    await mutations.sendFollowUp({ operationId: "op-none", environmentId: "env-1", threadId: "thread-9", instructions: "plain", mode: "queue" });
    assert.equal(calls.filter(call => call.payload.type === "message.dispatch").at(-1)!.payload.text, "plain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("marker values with whitespace or brackets are rejected before dispatch", async () => {
  const { dir, store } = await tempStore();
  const { calls, rpc } = captureRpc();
  const mutations = new Mutations(store, rpc);
  const base = { environmentId: "env-1", threadId: "thread-1", instructions: "x" };
  try {
    for (const bad of [
      { ...base, operationId: "op-a", wakeTarget: "huivou bot" },
      { ...base, operationId: "op-b", wakeTarget: "huivou]" },
      { ...base, operationId: "op c", wakeTarget: "huivou" },
      { ...base, operationId: "op-d", threadId: "thread\t1", wakeTarget: "huivou" },
    ]) {
      await assert.rejects(() => mutations.sendFollowUp(bad), (error: { code?: string }) => error.code === "invalid_input");
    }
    // Whitespace in operationId is still fine without a wakeTarget.
    await mutations.sendFollowUp({ ...base, operationId: "op with space" });
    assert.equal(calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function bounded(runs: Array<Record<string, unknown>>, status: string): BoundedView {
  const parsed = parseBounded({
    historyCursor: null,
    hasMoreHistory: false,
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status, interactionMode: "default", hasActionableProposedPlan: false, activeRunId: null },
      runs,
      runtimeRequests: [],
      visibleTurnItems: [{ id: "m1", type: "assistant_message", text: "done" }],
    },
  });
  if (!parsed.ok) throw new Error("bounded");
  return parsed.value;
}

test("bridge send_message with wakeTarget sends the marker and the watch still fires by userMessageId", async () => {
  const { dir, store } = await tempStore();
  const { calls, rpc } = captureRpc();
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const watcher = new Watcher(store, async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  });
  let current = bounded([], "working");
  const bridge = new Bridge({
    defaultEnvironmentId: "env-1",
    listLinked: async () => ({ environments: [], warnings: [] }),
    probe: async () => "online",
    shell: async () => ({ schemaVersion: null, snapshotSequence: null, projects: [], threads: [], warnings: [] }),
    bounded: async () => current,
    history: async () => ({ snapshotSequence: null, messages: [], historyCursor: null, hasMoreHistory: false, warnings: [] }),
    mutations: new Mutations(store, rpc),
    watcher,
    store,
  });
  try {
    const ack = await bridge.sendMessage({ operationId: "op-wake", threadId: "thread-1", instructions: "go", mode: "queue", wakeTarget: "huivou" });
    assert.equal(ack.watched, true);
    const text = String(calls.at(-1)!.payload.text);
    assert.equal(text, "go\n[t3b-wake target=huivou thread=thread-1 op=op-wake]");
    const watch = (await store.listWatches())[0];
    assert.equal(watch?.wakeTarget, "huivou");
    assert.equal(watch?.userMessageId, ack.userMessageId);
    current = bounded([{ id: "run-2", status: "completed", ordinal: 2, userMessageId: ack.userMessageId }], "idle");
    await bridge.tickWatches();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.url, "https://example.test/hooks/huivou");
    assert.equal(posts[0]!.body.runId, "run-2");
    assert.equal(posts[0]!.body.wakeTarget, "huivou");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
