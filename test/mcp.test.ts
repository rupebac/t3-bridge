import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toThreadListResult } from "../src/contracts.js";
import { Bridge } from "../src/bridge.js";
import { createServer, TOOL_NAMES, type ToolBridge } from "../src/server.js";
import { Store } from "../src/store.js";
import { Mutations } from "../src/tools/mutate.js";
import { Watcher } from "../src/watch.js";
import { parseBounded, parseShell } from "../src/protocol-v2.js";

const toolNames = [
  "list_environments",
  "list_projects",
  "list_threads",
  "get_thread",
  "start_thread",
  "send_message",
  "interrupt_thread",
  "set_thread_model",
  "set_thread_runtime",
  "rename_thread",
  "watch_thread",
  "unwatch_thread",
  "list_watches",
  "bridge_status",
  "register_webhook",
  "list_webhooks",
  "delete_webhook",
  "wait_thread",
  "list_deliveries",
  "replay_deliveries",
];

test("mcp server lists the stable tool surface", async () => {
  let seenModelInput: unknown;
  const listed = toThreadListResult({
    environmentId: "env-1",
    threads: [{
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Greeting",
      status: "idle",
      runtimeMode: "approval-required",
      updatedAt: null,
      activeRunId: null,
      latestRunId: null,
    }],
    total: 1,
    nextOffset: null,
  });
  const bridge = {
    listEnvironments: async () => ({ bridgeVersion: "0.1.0", environments: [], total: 0, nextOffset: null, warnings: [] }),
    listProjects: async () => ({ bridgeVersion: "0.1.0", environmentId: "env-1", projects: [], total: 0, nextOffset: null, warnings: [] }),
    listThreads: async () => listed,
    getThread: async () => ({
      bridgeVersion: "0.1.0",
      environmentId: "env-1",
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Greeting",
      status: "idle",
      runtimeMode: "approval-required",
      interactionMode: "default",
      activeRunId: null,
      latestRunId: null,
      messages: [],
      historyCursor: null,
      hasMoreHistory: false,
      warnings: [],
    }),
    startThread: async () => ({ bridgeVersion: "0.1.0", kind: "start_thread", operationId: "op", environmentId: "env-1", threadId: "thread-1", runId: "run-1", accepted: true, watched: true }),
    sendMessage: async () => ({ bridgeVersion: "0.1.0", kind: "send_message", operationId: "op", environmentId: "env-1", threadId: "thread-1", runId: null, accepted: true, watched: true }),
    interruptThread: async () => ({ bridgeVersion: "0.1.0", kind: "interrupt_thread", operationId: "op", environmentId: "env-1", threadId: "thread-1", runId: "run-1", accepted: true, watched: false }),
    setThreadModel: async (input: unknown) => { seenModelInput = input; return { bridgeVersion: "0.1.0", kind: "set_thread_model", operationId: "op", environmentId: "env-1", threadId: "thread-1", runId: null, userMessageId: null, accepted: true, watched: false }; },
    setThreadRuntime: async () => ({ bridgeVersion: "0.1.0", kind: "set_thread_runtime", operationId: "op", environmentId: "env-1", threadId: "thread-1", runId: null, accepted: true, watched: false }),
    renameThread: async () => ({ bridgeVersion: "0.1.0", kind: "rename_thread", operationId: "op", environmentId: "env-1", threadId: "thread-1", runId: null, accepted: true, watched: false }),
    watchThread: async () => ({ watchId: "w1" }),
    unwatchThread: async () => ({ removed: true }),
    listWatches: async () => ({ bridgeVersion: "0.1.0", watches: [], pendingDeliveries: 0 }),
    tickWatches: async () => undefined,
  };
  const server = createServer(bridge as unknown as ToolBridge);
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [...toolNames].sort());
    assert.deepEqual([...TOOL_NAMES].sort(), [...toolNames].sort());
    const result = await client.callTool({ name: "list_threads", arguments: {} });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { threads: Array<{ threadId: string }> };
    assert.equal(structured.threads[0]?.threadId, "thread-1");
    assert.equal(JSON.stringify(structured).includes("session"), false);
    const options = [{ id: "reasoningEffort", value: "high" }, { id: "serviceTier", value: "default" }];
    const modelResult = await client.callTool({
      name: "set_thread_model",
      arguments: { operationId: "op-model", threadId: "thread-1", modelSelection: { instanceId: "codex", model: "gpt-6-astra", options } },
    });
    assert.equal(modelResult.isError, undefined, JSON.stringify(modelResult.content));
    assert.deepEqual((seenModelInput as { modelSelection: unknown }).modelSelection, { instanceId: "codex", model: "gpt-6-astra", options });
  } finally {
    await client.close();
  }
});

test("start_thread arms a watch unless watch is false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-mcp-"));
  const store = await Store.load(dir);
  const shell = parseShell({
    projects: [{ id: "proj-1", title: "rperez", workspaceRoot: "/work", defaultModelSelection: { instanceId: "grok", model: "grok-4" } }],
    threads: [],
  });
  assert.equal(shell.ok, true);
  if (!shell.ok) return;
  const bounded = parseBounded({
    projection: { thread: { id: "thread-1", projectId: "proj-1", title: "Smoke", status: "running" }, runs: [], visibleTurnItems: [] },
    historyCursor: null,
    hasMoreHistory: false,
  });
  assert.equal(bounded.ok, true);
  if (!bounded.ok) return;
  const mutations = new Mutations(store, async (_environmentId, method, payload) => {
    if (method !== "orchestration.launchThread") return { sequence: 1 };
    const messageId = (payload.initialMessage as { messageId: string }).messageId;
    return { threadId: payload.threadId, projection: { runs: [{ id: "run-new", userMessageId: messageId }] } };
  });
  const bridge = new Bridge({
    defaultEnvironmentId: "env-1",
    listLinked: async () => ({ environments: [], warnings: [] }),
    probe: async () => "online",
    shell: async () => shell.value,
    bounded: async () => bounded.value,
    history: async () => ({ snapshotSequence: null, messages: [], historyCursor: null, hasMoreHistory: false, warnings: [] }),
    mutations,
    watcher: new Watcher(store, async () => new Response(null, { status: 204 })),
    store,
  });
  try {
    const armed = await bridge.startThread({ operationId: "op-1", projectId: "proj-1", title: "Smoke", instructions: "say hi" });
    assert.equal(armed.watched, true);
    assert.equal(armed.runId, "run-new");
    assert.equal((await store.listWatches())[0]?.runId, "run-new");
    const quiet = await bridge.startThread({ operationId: "op-2", projectId: "proj-1", title: "Smoke", instructions: "say hi", watch: false });
    assert.equal(quiet.watched, false);
    assert.equal((await store.listWatches()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
