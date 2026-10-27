import { test } from "node:test";
import assert from "node:assert/strict";
import { mapThreadRow, parseBounded, parseShell } from "../src/protocol-v2.js";

test("mapThreadRow accepts long ids and ignores unknown fields", () => {
  const longId = "x".repeat(500);
  const row = mapThreadRow({
    id: longId,
    projectId: "proj-1",
    title: "Greeting",
    weirdFutureField: { nested: true },
    runtimeMode: "full-access",
    updatedAt: "2026-10-25T11:14:07.100Z",
  });
  assert.equal(row?.threadId, longId);
  assert.equal(row?.title, "Greeting");
  assert.equal(row?.runtimeMode, "full-access");
  assert.equal("weirdFutureField" in (row ?? {}), false);
});

test("mapThreadRow rejects ids longer than 2000 characters", () => {
  const row = mapThreadRow({
    id: "y".repeat(2001),
    projectId: "proj-1",
    title: "Too long",
  });
  assert.equal(row, null);
});

test("mapThreadRow keeps an id of exactly 2000 characters", () => {
  const id = "z".repeat(2000);
  const row = mapThreadRow({ id, projectId: "p", title: "Edge" });
  assert.equal(row?.threadId, id);
});

test("parseShell keeps sibling rows when one thread or project is unusable", () => {
  const longId = "t".repeat(500);
  const parsed = parseShell({
    schemaVersion: 2,
    snapshotSequence: 4,
    futureShellField: true,
    projects: [
      {
        id: "proj-1",
        title: "rperez",
        workspaceRoot: "/work/rperez",
        defaultModelSelection: { instanceId: "grok", model: "grok-4", options: [{ id: "effort", value: "high" }] },
        extra: { noisy: true },
      },
      { id: "bad-project" },
    ],
    threads: [
      {
        id: longId,
        projectId: "proj-1",
        title: "Greeting",
        status: "running",
        runtimeMode: "approval-required",
        updatedAt: "2026-10-25T11:14:07.100Z",
        weirdFutureField: { nested: true },
      },
      { id: "y".repeat(2001), projectId: "proj-1", title: "dropped" },
      { id: "gone", projectId: "proj-1", title: "deleted", deletedAt: "2026-10-25T11:00:00.000Z" },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.threads.length, 1);
  assert.equal(parsed.value.threads[0]?.threadId, longId);
  assert.equal(parsed.value.projects.length, 1);
  assert.equal(parsed.value.projects[0]?.title, "rperez");
  assert.deepEqual(parsed.value.projects[0]?.defaultModelSelection, { instanceId: "grok", model: "grok-4" });
  assert.ok(parsed.value.warnings.length >= 2);
  assert.equal(JSON.stringify(parsed.value).includes("weirdFutureField"), false);
  assert.equal(JSON.stringify(parsed.value).includes("noisy"), false);
});

test("parseBounded ignores unknown item fields and skips a bad row", () => {
  const parsed = parseBounded({
    snapshotSequence: 9,
    historyCursor: "older",
    hasMoreHistory: true,
    extra: true,
    projection: {
      thread: { id: "thread-1", projectId: "proj-1", title: "Greeting", status: "completed" },
      runs: [
        { id: "run-1", ordinal: 1, status: "completed", userMessageId: "m-user", surprise: 1 },
        { id: "" },
      ],
      runtimeRequests: [],
      visibleTurnItems: [
        {
          position: 0,
          item: { id: "m-user", type: "user_message", text: "hello", messageId: "m-user", payload: { secret: "nope" } },
        },
        { position: 1, item: { type: "assistant_message" } },
        {
          position: 2,
          item: { id: "m-assistant", type: "assistant_message", text: "done", messageId: "m-assistant" },
        },
      ],
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.runs.length, 1);
  assert.deepEqual(parsed.value.messages.map(message => message.text), ["hello", "done"]);
  assert.equal(parsed.value.historyCursor, "older");
  assert.equal(parsed.value.hasMoreHistory, true);
  assert.equal(JSON.stringify(parsed.value).includes("nope"), false);
  assert.ok(parsed.value.warnings.length >= 1);
});
