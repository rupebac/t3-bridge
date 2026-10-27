import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MESSAGE_TEXT_LIMIT,
  toEnvironmentListResult,
  toMutationAck,
  toProjectListResult,
  toThreadDetailResult,
  toThreadListResult,
} from "../src/contracts.js";

const environmentId = "43972768-c214-40da-acbe-c9ea9a2e3bd4";

test("thread list result stringifies to documented keys only", () => {
  const result = toThreadListResult({
    environmentId,
    threads: [
      {
        threadId: "thread-1",
        projectId: "proj-1",
        title: "Greeting",
        status: "finished",
        runtimeMode: "approval-required",
        updatedAt: "2026-10-25T11:14:07.100Z",
        activeRunId: null,
        latestRunId: "run-1",
        weirdFutureField: { nested: true },
        session: { status: "ready", secret: "do-not-leak" },
        messages: [{ text: "raw projection" }],
      },
    ],
    total: 1,
    nextOffset: null,
    warnings: ["skipped 1 thread"],
  });
  const json = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(json).sort(), [
    "bridgeVersion",
    "environmentId",
    "nextOffset",
    "threads",
    "total",
    "warnings",
  ]);
  const thread = (json.threads as Record<string, unknown>[])[0]!;
  assert.deepEqual(Object.keys(thread).sort(), [
    "activeRunId",
    "latestRunId",
    "projectId",
    "runtimeMode",
    "status",
    "threadId",
    "title",
    "updatedAt",
  ]);
  assert.equal(JSON.stringify(result).includes("do-not-leak"), false);
  assert.equal(JSON.stringify(result).includes("weirdFutureField"), false);
  assert.deepEqual(result, {
    bridgeVersion: "0.1.0",
    environmentId,
    threads: [
      {
        threadId: "thread-1",
        projectId: "proj-1",
        title: "Greeting",
        status: "finished",
        runtimeMode: "approval-required",
        updatedAt: "2026-10-25T11:14:07.100Z",
        activeRunId: null,
        latestRunId: "run-1",
      },
    ],
    total: 1,
    nextOffset: null,
    warnings: ["skipped 1 thread"],
  });
});

test("get_thread clips each message to 8000 characters", () => {
  const text = `${"a".repeat(7990)}SENTINEL-SHOULD-DROP`;
  const result = toThreadDetailResult({
    environmentId,
    threadId: "thread-1",
    projectId: "proj-1",
    title: "Greeting",
    status: "finished",
    runtimeMode: "approval-required",
    interactionMode: "default",
    activeRunId: null,
    latestRunId: "run-1",
    messages: [
      { id: "m-user", role: "user", text: "hello", payload: { token: "secret" } },
      { id: "m-assistant", role: "assistant", text, extra: true },
    ],
    historyCursor: "cursor-1",
    hasMoreHistory: true,
    warnings: [],
    lastError: null,
    planReady: false,
    pendingRequest: null,
    run: { id: "run-1", status: "finished", error: null },
  });
  assert.equal(MESSAGE_TEXT_LIMIT, 8_000);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1]!.text.length <= MESSAGE_TEXT_LIMIT, true);
  assert.equal(result.messages[1]!.text.length, MESSAGE_TEXT_LIMIT);
  assert.equal(result.messages[1]!.text.endsWith("\n[truncated]"), true);
  assert.equal(result.messages[1]!.text.includes("SENTINEL"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(Object.keys(result).sort(), [
    "activeRunId",
    "bridgeVersion",
    "environmentId",
    "hasMoreHistory",
    "historyCursor",
    "interactionMode",
    "lastError",
    "latestRunId",
    "messages",
    "pendingRequest",
    "planReady",
    "projectId",
    "run",
    "runtimeMode",
    "status",
    "threadId",
    "title",
    "warnings",
  ]);
  assert.deepEqual(Object.keys(result.messages[0]!).sort(), ["id", "role", "text"]);
});

test("environment, project, and mutation results stay on the documented shapes", () => {
  const environments = toEnvironmentListResult({
    environments: [
      {
        environmentId,
        label: "menet2",
        endpoint: "https://prod-5b0033d0c6e7d351.t3coderelay.com/",
        availability: "online",
        credential: "bootstrap-secret",
      },
    ],
    total: 1,
    nextOffset: null,
    warnings: [],
  });
  const projects = toProjectListResult({
    environmentId,
    projects: [
      {
        projectId: "proj-1",
        title: "rperez",
        workspaceRoot: "/home/box/rperez",
        defaultModel: { instanceId: "grok", model: "grok-4", options: [{ id: "effort", value: "high" }] },
      },
    ],
    total: 1,
    nextOffset: null,
    warnings: [],
  });
  const ack = toMutationAck({
    kind: "start_thread",
    operationId: "op-1",
    environmentId,
    threadId: "thread-1",
    runId: "run-1",
    accepted: true,
    watched: true,
    commands: [{ text: "hidden" }],
  });
  assert.equal(JSON.stringify(environments).includes("bootstrap-secret"), false);
  assert.equal(JSON.stringify(projects).includes("effort"), false);
  assert.equal(JSON.stringify(ack).includes("hidden"), false);
  assert.deepEqual(environments.environments[0], {
    environmentId,
    label: "menet2",
    endpoint: "https://prod-5b0033d0c6e7d351.t3coderelay.com/",
    availability: "online",
  });
  assert.deepEqual(projects.projects[0]?.defaultModel, { instanceId: "grok", model: "grok-4" });
  assert.deepEqual(ack, {
    bridgeVersion: "0.1.0",
    kind: "start_thread",
    operationId: "op-1",
    environmentId,
    threadId: "thread-1",
    runId: "run-1",
    userMessageId: null,
    accepted: true,
    watched: true,
  });
});
