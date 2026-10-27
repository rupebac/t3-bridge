import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/bridge.js";
import { ClerkAuth } from "../src/auth.js";
import { readConfig } from "../src/config.js";
import { Connect } from "../src/connect.js";
import { Http } from "../src/http.js";
import { mapProject, mapThreadRow, parseBounded, type BoundedView } from "../src/protocol-v2.js";
import { createServer, type ToolBridge } from "../src/server.js";
import { Store } from "../src/store.js";
import { Mutations } from "../src/tools/mutate.js";
import { detailFromRead } from "../src/tools/read.js";
import { Watcher } from "../src/watch.js";

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-review-"));
  const store = await Store.load(dir);
  await store.saveWebhook({ url: "https://example.test/hooks/t3", secret: "whsec_test" });
  return { dir, store };
}

function snapshot(input: {
  status?: string;
  interactionMode?: string;
  hasActionableProposedPlan?: boolean;
  activeRunId?: string | null;
  runs: Array<{ id: string; status: string; ordinal?: number; userMessageId?: string | null }>;
}): BoundedView {
  const parsed = parseBounded({
    projection: {
      thread: {
        id: "thread-1",
        projectId: "proj-1",
        title: "Smoke",
        status: input.status ?? "idle",
        interactionMode: input.interactionMode ?? "default",
        hasActionableProposedPlan: input.hasActionableProposedPlan ?? false,
        activeRunId: input.activeRunId ?? null,
      },
      runs: input.runs,
      visibleTurnItems: [{ id: "m1", type: "assistant_message", text: "done" }],
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("snapshot");
  return parsed.value;
}

test("bare watch does not fire for the previous finished run and then fires once for a newer run", async () => {
  const { dir, store } = await tempStore();
  const posts: Array<{ runId?: string; status?: string; event?: string }> = [];
  const watcher = new Watcher(store, async (_url, init) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  });
  let current = snapshot({
    status: "idle",
    runs: [{ id: "run-old", status: "completed", ordinal: 1, userMessageId: "msg-old" }],
  });
  const bridge = new Bridge({
    defaultEnvironmentId: "env-1",
    listLinked: async () => ({ environments: [], warnings: [] }),
    probe: async () => "online",
    shell: async () => ({ schemaVersion: null, snapshotSequence: null, projects: [], threads: [], warnings: [] }),
    bounded: async () => current,
    history: async () => ({ snapshotSequence: null, messages: [], historyCursor: null, hasMoreHistory: false, warnings: [] }),
    mutations: new Mutations(store, async () => ({})),
    watcher,
    store,
  });
  try {
    await bridge.watchThread({ threadId: "thread-1" });
    await bridge.tickWatches();
    assert.equal(posts.length, 0);
    assert.equal((await store.listWatches())[0]?.baselineRunId, "run-old");
    current = snapshot({
      status: "idle",
      runs: [
        { id: "run-old", status: "completed", ordinal: 1, userMessageId: "msg-old" },
        { id: "run-new", status: "completed", ordinal: 2, userMessageId: "msg-new" },
      ],
    });
    await bridge.tickWatches();
    await bridge.tickWatches();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.event, "t3.run.terminal");
    assert.equal(posts[0]?.runId, "run-new");
    assert.equal(posts[0]?.status, "finished");
    assert.equal((await store.listWatches()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("send_message waits for its own run when the thread header is idle", async () => {
  const { dir, store } = await tempStore();
  const posts: Array<{ runId?: string; status?: string }> = [];
  const watcher = new Watcher(store, async (_url, init) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  });
  let current = snapshot({
    status: "idle",
    runs: [{ id: "run-old", status: "completed", ordinal: 1, userMessageId: "msg-old" }],
  });
  const bridge = new Bridge({
    defaultEnvironmentId: "env-1",
    listLinked: async () => ({ environments: [], warnings: [] }),
    probe: async () => "online",
    shell: async () => ({ schemaVersion: null, snapshotSequence: null, projects: [], threads: [], warnings: [] }),
    bounded: async () => current,
    history: async () => ({ snapshotSequence: null, messages: [], historyCursor: null, hasMoreHistory: false, warnings: [] }),
    mutations: new Mutations(store, async () => ({ sequence: 1 })),
    watcher,
    store,
  });
  try {
    const ack = await bridge.sendMessage({ operationId: "op-send", threadId: "thread-1", instructions: "next", mode: "queue" });
    assert.equal(ack.accepted, true);
    assert.equal(ack.runId, null);
    assert.equal(ack.watched, true);
    const watch = (await store.listWatches())[0];
    assert.equal(watch?.runId, null);
    assert.equal(typeof watch?.userMessageId, "string");
    await bridge.tickWatches();
    assert.equal(posts.length, 0);
    current = snapshot({
      status: "idle",
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      activeRunId: null,
      runs: [
        { id: "run-old", status: "completed", ordinal: 1, userMessageId: "msg-old" },
        { id: "run-new", status: "completed", ordinal: 2, userMessageId: watch?.userMessageId ?? "" },
      ],
    });
    await bridge.tickWatches();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.runId, "run-new");
    assert.equal(posts[0]?.status, "finished");
    assert.equal((await store.listWatches()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("launch stays accepted when the run list is missing or a row has a null message id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-launch-tolerant-"));
  const store = await Store.load(dir);
  const responses: unknown[] = [];
  const mutations = new Mutations(store, async (_environmentId, _method, payload) => {
    const next = responses.shift();
    if (next && typeof next === "object") return { ...(next as object), threadId: (next as { threadId?: string }).threadId ?? payload.threadId };
    return next;
  });
  try {
    responses.push({ projection: {} });
    const missing = await mutations.launchThread({
      operationId: "op-missing",
      environmentId: "env-1",
      projectId: "proj-1",
      title: "Smoke",
      instructions: "hi",
      modelSelection: { instanceId: "grok", model: "grok-4" },
    });
    assert.equal(missing.accepted, true);
    assert.equal(missing.runId, null);
    assert.equal(typeof missing.userMessageId, "string");

    responses.push({ projection: { runs: [{ id: "run-x", userMessageId: null, status: "running" }] } });
    const nulled = await mutations.launchThread({
      operationId: "op-null",
      environmentId: "env-1",
      projectId: "proj-1",
      title: "Smoke",
      instructions: "hi",
      modelSelection: { instanceId: "grok", model: "grok-4" },
    });
    assert.equal(nulled.accepted, true);
    assert.equal(nulled.runId, null);

    responses.push({ threadId: "someone-else" });
    await assert.rejects(
      () => mutations.launchThread({
        operationId: "op-mismatch",
        environmentId: "env-1",
        projectId: "proj-1",
        title: "Smoke",
        instructions: "hi",
        modelSelection: { instanceId: "grok", model: "grok-4" },
      }),
      (error: { code?: string }) => error.code === "identity_mismatch",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tick already in progress does not deliver twice, and deleting the watch is not undone", async () => {
  const { dir, store } = await tempStore();
  let entered = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const watcher = new Watcher(store, async () => new Response(null, { status: 204 }));
  await watcher.armWatch({
    environmentId: "env-1",
    projectId: "proj-1",
    threadId: "thread-1",
    title: "Smoke",
    runId: "run-1",
    notifyOnAttention: false,
  });
  const first = watcher.tickWatches(async () => {
    entered += 1;
    await gate;
    return { runId: "run-1", status: "working" };
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  await watcher.tickWatches(async () => {
    entered += 1;
    return { runId: "run-1", status: "finished" };
  });
  assert.equal(entered, 1);
  release();
  await first;

  let posts = 0;
  const racing = new Watcher(store, async () => {
    posts += 1;
    const [watch] = await store.listWatches();
    if (watch) await store.deleteWatch(watch.watchId);
    return new Response(null, { status: 204 });
  });
  await racing.armWatch({
    environmentId: "env-1",
    projectId: "proj-1",
    threadId: "thread-2",
    title: "Smoke",
    runId: "run-2",
    notifyOnAttention: false,
  });
  await racing.tickWatches(async () => ({ runId: "run-2", status: "finished", threadId: "thread-2" }));
  assert.equal(posts, 1);
  assert.equal((await store.listWatches()).some(watch => watch.threadId === "thread-2"), false);
  await racing.armWatch({
    environmentId: "env-1",
    projectId: "proj-1",
    threadId: "thread-2",
    title: "Smoke",
    runId: "run-2",
    notifyOnAttention: false,
  });
  await racing.tickWatches(async () => ({ runId: "run-2", status: "finished", threadId: "thread-2" }));
  assert.equal(posts, 1);
  await rm(dir, { recursive: true, force: true });
});

test("odd nested fields do not drop a thread or project row", () => {
  const longError = "e".repeat(9_000);
  const row = mapThreadRow({
    id: "thread-1",
    projectId: "proj-1",
    title: "Kept",
    status: "",
    archivedAt: "",
    interactionMode: "",
    lastError: longError,
    modelSelection: { provider: "grok", model: "grok-4" },
    pendingRuntimeRequest: { id: "req-1" },
  });
  assert.equal(row?.threadId, "thread-1");
  assert.equal(row?.status, null);
  assert.equal(row?.archivedAt, null);
  assert.equal(row?.interactionMode, null);
  assert.equal(row?.modelSelection, null);
  assert.equal(row?.pendingRuntimeRequest, null);
  assert.ok((row?.lastError?.length ?? 0) > 0);
  assert.ok((row?.lastError?.length ?? 9_001) <= 8_000);
  const parsed = parseBounded({
    projection: { thread: { id: "thread-1", projectId: "proj-1", title: "Kept", status: "" }, runs: [], visibleTurnItems: [] },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.thread?.threadId, "thread-1");
  const project = mapProject({
    id: "proj-1",
    title: "rperez",
    defaultModelSelection: { provider: "grok", model: "grok-4" },
  });
  assert.equal(project?.projectId, "proj-1");
  assert.equal(project?.defaultModelSelection, null);
});

test("list_projects output schema accepts a model id longer than 200 characters", async () => {
  const instanceId = "m".repeat(500);
  const bridge = {
    listEnvironments: async () => ({ bridgeVersion: "0.1.0", environments: [], total: 0, nextOffset: null, warnings: [] }),
    listProjects: async () => ({
      bridgeVersion: "0.1.0",
      environmentId: "env-1",
      projects: [{ projectId: "proj-1", title: "rperez", workspaceRoot: "/work", defaultModel: { instanceId, model: "grok-4" } }],
      total: 1,
      nextOffset: null,
      warnings: [],
    }),
    listThreads: async () => ({ bridgeVersion: "0.1.0", environmentId: "env-1", threads: [], total: 0, nextOffset: null, warnings: [] }),
    getThread: async () => ({ bridgeVersion: "0.1.0", environmentId: "env-1", threadId: "thread-1", projectId: "proj-1", title: "t", status: "idle", runtimeMode: null, interactionMode: null, activeRunId: null, latestRunId: null, messages: [], historyCursor: null, hasMoreHistory: false, warnings: [] }),
    startThread: async () => ({ bridgeVersion: "0.1.0", kind: "start_thread", operationId: "op", environmentId: "env-1", threadId: "thread-1", runId: null, accepted: true, watched: false }),
    sendMessage: async () => ({ bridgeVersion: "0.1.0", kind: "send_message", operationId: "op", environmentId: "env-1", threadId: "thread-1", runId: null, accepted: true, watched: false }),
    interruptThread: async () => ({ bridgeVersion: "0.1.0", kind: "interrupt_thread", operationId: "op", environmentId: "env-1", threadId: "thread-1", runId: null, accepted: true, watched: false }),
    setThreadModel: async () => ({ bridgeVersion: "0.1.0", kind: "set_thread_model", operationId: "op", environmentId: "env-1", threadId: "thread-1", runId: null, accepted: true, watched: false }),
    setThreadRuntime: async () => ({ bridgeVersion: "0.1.0", kind: "set_thread_runtime", operationId: "op", environmentId: "env-1", threadId: "thread-1", runId: null, accepted: true, watched: false }),
    renameThread: async () => ({ bridgeVersion: "0.1.0", kind: "rename_thread", operationId: "op", environmentId: "env-1", threadId: "thread-1", runId: null, accepted: true, watched: false }),
    watchThread: async () => ({ watchId: "w" }),
    unwatchThread: async () => ({ removed: true }),
    listWatches: async () => ({ bridgeVersion: "0.1.0", watches: [], pendingDeliveries: 0, warnings: [] }),
    tickWatches: async () => undefined,
  };
  const server = createServer(bridge as unknown as ToolBridge);
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name: "list_projects", arguments: {} });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { projects: Array<{ defaultModel: { instanceId: string } }> };
    assert.equal(structured.projects[0]?.defaultModel.instanceId, instanceId);
  } finally {
    await client.close();
  }
});

test("a bad environment endpoint does not hide the valid rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-env-"));
  const store = await Store.load(dir);
  const config = readConfig({
    T3_BRIDGE_STATE_DIR: dir,
    T3_BRIDGE_CLERK_ORIGIN: "https://clerk.example",
    T3_BRIDGE_RELAY_ORIGIN: "https://relay.example",
  });
  const http = {
    request: async () => ({
      data: {
        environments: [
          { environmentId: "good", label: "menet2", endpoint: { httpBaseUrl: "https://good.example/", wsBaseUrl: "wss://good.example/ws" } },
          { environmentId: "bad", label: "odd", endpoint: { httpBaseUrl: "https://bad.example/extra", wsBaseUrl: "wss://bad.example/socket" } },
        ],
      },
      headers: new Headers(),
    }),
  } as unknown as Http;
  const auth = { token: async () => "jwt" } as unknown as ClerkAuth;
  const connect = new Connect(config, http, auth, store);
  try {
    const listed = await connect.listEnvironments();
    assert.deepEqual(listed.environments.map(environment => environment.environmentId), ["good"]);
    assert.equal(listed.warnings.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a second store re-reads before writing and listWatches returns copies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-lock-"));
  const first = await Store.load(dir);
  const second = await Store.load(dir);
  try {
    await first.saveWebhook({ url: "https://example.test/hooks/t3", secret: "whsec_test" });
    await second.saveWatch({
      watchId: "w1",
      environmentId: "env-1",
      projectId: null,
      threadId: "thread-1",
      title: null,
      runId: null,
      notifyOnAttention: false,
      armedAt: "2026-10-25T00:00:00.000Z",
    });
    const reloaded = await Store.load(dir);
    assert.equal((await reloaded.getWebhookConfig())?.secret, "whsec_test");
    const [watch] = await reloaded.listWatches();
    assert.ok(watch);
    watch.title = "mutated";
    assert.equal((await reloaded.listWatches())[0]?.title, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("get_thread keeps the newest messages inside the count and character budget", () => {
  const messages = Array.from({ length: 30 }, (_unused, index) => ({
    id: `m-${index}`,
    role: "assistant" as const,
    text: "x".repeat(8_000),
  }));
  const detail = detailFromRead("env-1", {
    snapshotSequence: null,
    thread: {
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Smoke",
      runtimeMode: null,
      interactionMode: null,
      status: "idle",
      createdAt: null,
      updatedAt: null,
      archivedAt: null,
      deletedAt: null,
      activeRunId: null,
      latestRunId: null,
      activityRunStatus: null,
      lastError: null,
      pendingRuntimeRequest: null,
      hasActionableProposedPlan: false,
      modelSelection: null,
      latestUserMessageAt: null,
    },
    runs: [],
    messages,
    runtimeRequests: [],
    historyCursor: null,
    hasMoreHistory: false,
    warnings: [],
  }, undefined, 100);
  assert.ok(detail.messages.length < 30);
  assert.ok(detail.messages.length <= 20 || detail.messages.reduce((sum, message) => sum + message.text.length, 0) <= 60_000);
  assert.equal(detail.hasMoreHistory, true);
  assert.equal(detail.messages.at(-1)?.id, "m-29");
  assert.ok(detail.historyCursor);
});
