import { test } from "node:test";
import assert from "node:assert/strict";
import { isAttention, isTerminal, mapRunStatus } from "../src/status.js";

test("mapRunStatus maps raw v2 run states onto bridge enums", () => {
  assert.equal(mapRunStatus("preparing"), "preparing");
  assert.equal(mapRunStatus("starting"), "connecting");
  assert.equal(mapRunStatus("running"), "working");
  assert.equal(mapRunStatus("queued"), "queued");
  assert.equal(mapRunStatus("waiting"), "waiting");
  assert.equal(mapRunStatus("monitoring"), "monitoring");
  assert.equal(mapRunStatus("completed"), "finished");
  assert.equal(mapRunStatus("failed"), "failed");
  assert.equal(mapRunStatus("interrupted"), "interrupted");
  assert.equal(mapRunStatus("stopped"), "stopped");
  assert.equal(mapRunStatus("cancelled"), "cancelled");
  assert.equal(mapRunStatus("rolled_back"), "rolled_back");
  assert.equal(mapRunStatus("idle"), "idle");
  assert.equal(mapRunStatus("something-new"), "unknown");
  assert.equal(mapRunStatus("canceled"), "cancelled");
  assert.equal(mapRunStatus("error"), "failed");
  assert.equal(mapRunStatus("errored"), "failed");
  assert.equal(mapRunStatus("succeeded"), "finished");
  assert.equal(mapRunStatus("complete"), "finished");
  assert.equal(mapRunStatus("success"), "finished");
});

test("pending requests and actionable plans outrank a working run", () => {
  assert.equal(mapRunStatus("running", { pendingKind: "command" }), "awaiting_approval");
  assert.equal(mapRunStatus("running", { pendingKind: "user_input" }), "awaiting_input");
  assert.equal(mapRunStatus("completed", { interactionMode: "plan", hasActionableProposedPlan: true }), "plan_ready");
  assert.equal(mapRunStatus("completed", { interactionMode: "plan", hasActionableProposedPlan: false }), "finished");
});

test("terminal and attention classifiers follow the webhook spec", () => {
  for (const status of ["finished", "failed", "interrupted", "stopped", "cancelled", "rolled_back"]) {
    assert.equal(isTerminal(status), true);
    assert.equal(isAttention(status), false);
  }
  for (const status of ["working", "connecting", "preparing", "queued", "waiting", "monitoring"]) {
    assert.equal(isTerminal(status), false, status);
    assert.equal(isAttention(status), false, status);
  }
  for (const status of ["awaiting_approval", "awaiting_input", "plan_ready"]) {
    assert.equal(isTerminal(status), false, status);
    assert.equal(isAttention(status), true, status);
  }
});
