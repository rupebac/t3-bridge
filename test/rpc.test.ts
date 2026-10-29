import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { BridgeError } from "../src/errors.js";
import { unaryRpc } from "../src/rpc.js";
import { Store } from "../src/store.js";
import { Mutations } from "../src/tools/mutate.js";

test("retry resends the journaled command id for the same operationId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-rpc-"));
  const store = await Store.load(dir);
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let attempts = 0;
  const rpc = async (_environmentId: string, method: string, payload: Record<string, unknown>) => {
    attempts += 1;
    calls.push({ method, payload });
    if (attempts === 1) throw new BridgeError("transport_error", "The RPC connection closed before acceptance was confirmed.");
    return { sequence: 3, extra: true };
  };
  const mutations = new Mutations(store, rpc);
  const input = {
    operationId: "op-1",
    environmentId: "env-1",
    threadId: "thread-1",
    instructions: "continue",
    mode: "queue" as const,
  };
  await assert.rejects(() => mutations.sendFollowUp(input), (error: { code?: string }) => error.code === "transport_error");
  const ack = await mutations.sendFollowUp(input);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.method, "orchestration.dispatchCommand");
  assert.equal(calls[0]?.payload.commandId, calls[1]?.payload.commandId);
  assert.equal(calls[0]?.payload.messageId, calls[1]?.payload.messageId);
  assert.equal((calls[0]?.payload.dispatchMode as { type?: string }).type, "queue_after_active");
  const saved = await store.getOperation("op-1") as { command?: { commandId?: string } };
  assert.equal(saved.command?.commandId, calls[0]?.payload.commandId);
  assert.equal(ack.accepted, true);
  assert.equal(ack.operationId, "op-1");
  assert.equal(JSON.stringify(ack).includes("extra"), false);
  await assert.rejects(
    () => mutations.sendFollowUp({ ...input, instructions: "different" }),
    (error: { code?: string }) => error.code === "operation_conflict",
  );
  await rm(dir, { recursive: true, force: true });
});

test("launch defaults to auto runtime mode and steer pins the active run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-launch-"));
  const store = await Store.load(dir);
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const rpc = async (_environmentId: string, method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    if (method === "orchestration.launchThread") {
      const messageId = (payload.initialMessage as { messageId: string }).messageId;
      return {
        threadId: payload.threadId,
        resumed: false,
        projection: { thread: { id: payload.threadId }, runs: [{ id: "run-new", status: "running", userMessageId: messageId, ordinal: 1 }] },
        future: true,
      };
    }
    return { sequence: 1 };
  };
  const mutations = new Mutations(store, rpc, async () => ({ id: "run-active", status: "running" }));
  const launched = await mutations.launchThread({
    operationId: "op-launch",
    environmentId: "env-1",
    projectId: "proj-1",
    title: "Smoke",
    instructions: "say hi",
    modelSelection: { instanceId: "grok", model: "grok-4" },
  });
  assert.equal(calls[0]?.payload.runtimeMode, "auto");
  assert.deepEqual(calls[0]?.payload.modelSelection, { instanceId: "grok", model: "grok-4" });
  assert.equal((calls[0]?.payload.workspaceStrategy as { type: string }).type, "root");
  assert.equal(launched.runId, "run-new");
  assert.equal(JSON.stringify(launched).includes("future"), false);

  await mutations.sendFollowUp({
    operationId: "op-steer",
    environmentId: "env-1",
    threadId: "thread-1",
    instructions: "narrow that",
    mode: "steer",
  });
  const steer = calls.at(-1)?.payload.dispatchMode as { type?: string; targetRunId?: string };
  assert.equal(steer.type, "steer_active");
  assert.equal(steer.targetRunId, "run-active");

  await mutations.setThreadModel({
    operationId: "op-model",
    environmentId: "env-1",
    threadId: "thread-1",
    modelSelection: { instanceId: "grok", model: "grok-4" },
  });
  await mutations.setThreadRuntime({
    operationId: "op-runtime",
    environmentId: "env-1",
    threadId: "thread-1",
    runtimeMode: "full-access",
  });
  await mutations.renameThread({
    operationId: "op-rename",
    environmentId: "env-1",
    threadId: "thread-1",
    title: "Renamed",
  });
  await mutations.interruptRun({ operationId: "op-stop", environmentId: "env-1", threadId: "thread-1" });
  const types = calls.map(call => call.payload.type);
  assert.deepEqual(types.slice(1), [
    "message.dispatch",
    "thread.model-selection.set",
    "thread.runtime-mode.set",
    "thread.metadata.update",
    "run.interrupt",
  ]);
  assert.equal(calls.at(-1)?.payload.runId, "run-active");
  await rm(dir, { recursive: true, force: true });
});

test("unary RPC ignores extra success fields and hides failure bodies", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const frames: unknown[] = [];
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on("message", data => {
        const frame = JSON.parse(String(data));
        frames.push(frame);
        if (frame.tag === "fail.me") {
          ws.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Failure", value: { message: "SECRET upstream" } } }));
          return;
        }
        ws.send(JSON.stringify({ _tag: "Pong" }));
        ws.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: { sequence: 4, extra: true } } }));
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const value = await unaryRpc(`ws://127.0.0.1:${port}`, "orchestration.dispatchCommand", { type: "thread.metadata.update", commandId: "c1" });
    assert.equal((value as { sequence: number }).sequence, 4);
    const request = frames[0] as { _tag: string; id: string; tag: string; payload: { commandId: string } };
    assert.equal(request._tag, "Request");
    assert.equal(request.tag, "orchestration.dispatchCommand");
    assert.equal(request.payload.commandId, "c1");
    await assert.rejects(
      () => unaryRpc(`ws://127.0.0.1:${port}`, "fail.me", { commandId: "c2" }),
      (error: { code?: string; message?: string }) => error.code === "rpc_error" && !String(error.message).includes("SECRET"),
    );
  } finally {
    wss.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launch keeps an explicit runtimeMode and model options reach T3", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-options-"));
  const store = await Store.load(dir);
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const rpc = async (_environmentId: string, method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    if (method === "orchestration.launchThread") {
      const messageId = (payload.initialMessage as { messageId: string }).messageId;
      return { threadId: payload.threadId, projection: { runs: [{ id: "run-new", userMessageId: messageId }] } };
    }
    return { sequence: 1 };
  };
  const mutations = new Mutations(store, rpc);
  const options = [{ id: "reasoningEffort", value: "high" }, { id: "serviceTier", value: "default" }];
  await mutations.launchThread({
    operationId: "op-launch-approval",
    environmentId: "env-1",
    projectId: "proj-1",
    title: "Strict",
    instructions: "say hi",
    modelSelection: { instanceId: "codex", model: "gpt-6-astra", options },
    runtimeMode: "approval-required",
  });
  assert.equal(calls[0]?.payload.runtimeMode, "approval-required");
  assert.deepEqual(calls[0]?.payload.modelSelection, { instanceId: "codex", model: "gpt-6-astra", options });

  await mutations.setThreadModel({
    operationId: "op-model-options",
    environmentId: "env-1",
    threadId: "thread-1",
    modelSelection: { instanceId: "codex", model: "gpt-6-astra", options },
  });
  assert.deepEqual(calls.at(-1)?.payload.modelSelection, { instanceId: "codex", model: "gpt-6-astra", options });

  await mutations.setThreadModel({
    operationId: "op-model-empty",
    environmentId: "env-1",
    threadId: "thread-1",
    modelSelection: { instanceId: "grok", model: "grok-4", options: [] },
  });
  assert.deepEqual(calls.at(-1)?.payload.modelSelection, { instanceId: "grok", model: "grok-4" });
  await rm(dir, { recursive: true, force: true });
});
