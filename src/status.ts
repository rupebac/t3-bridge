import type { ThreadSummary } from "./protocol-v2.js";

export const TERMINAL_STATUSES = ["finished", "failed", "interrupted", "stopped", "cancelled", "rolled_back"] as const;
export const ATTENTION_STATUSES = ["awaiting_approval", "awaiting_input", "plan_ready"] as const;
export const WORKING_STATUSES = ["working", "connecting", "preparing", "queued", "waiting", "monitoring"] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type AttentionStatus = (typeof ATTENTION_STATUSES)[number];
export type WorkingStatus = (typeof WORKING_STATUSES)[number];
export type BridgeStatus = TerminalStatus | AttentionStatus | WorkingStatus | "idle" | "unknown";

const terminal = new Set<string>(TERMINAL_STATUSES);
const attention = new Set<string>(ATTENTION_STATUSES);

const rawToBridge: Record<string, BridgeStatus> = {
  preparing: "preparing",
  starting: "connecting",
  running: "working",
  queued: "queued",
  waiting: "waiting",
  monitoring: "monitoring",
  completed: "finished",
  finished: "finished",
  failed: "failed",
  interrupted: "interrupted",
  stopped: "stopped",
  cancelled: "cancelled",
  canceled: "cancelled",
  error: "failed",
  errored: "failed",
  succeeded: "finished",
  complete: "finished",
  success: "finished",
  rolled_back: "rolled_back",
  idle: "idle",
  working: "working",
  connecting: "connecting",
  awaiting_approval: "awaiting_approval",
  awaiting_input: "awaiting_input",
  plan_ready: "plan_ready",
  unknown: "unknown",
};

const approvalKinds = new Set(["command", "file-read", "file-change", "file_read", "file_change", "mcp-elicitation", "approval", "approval_request"]);
const inputKinds = new Set(["user_input", "user-input"]);

export interface StatusHints {
  pendingKind?: string | null;
  interactionMode?: string | null;
  hasActionableProposedPlan?: boolean;
}

export function mapRunStatus(raw: string | null | undefined, hints: StatusHints = {}): BridgeStatus {
  const pending = hints.pendingKind ?? null;
  if (pending && inputKinds.has(pending)) return "awaiting_input";
  if (pending && (approvalKinds.has(pending) || pending.length > 0)) return "awaiting_approval";
  const mapped = rawToBridge[(raw ?? "").trim().toLowerCase()] ?? "unknown";
  if (mapped === "finished" && hints.interactionMode === "plan" && hints.hasActionableProposedPlan) return "plan_ready";
  return mapped;
}

export function isTerminal(status: string): status is TerminalStatus {
  return terminal.has(status);
}

export function isAttention(status: string): status is AttentionStatus {
  return attention.has(status);
}

export function statusOf(
  thread: Pick<ThreadSummary, "activityRunStatus" | "status" | "pendingRuntimeRequest" | "interactionMode" | "hasActionableProposedPlan">,
  latestRunStatus?: string | null,
): BridgeStatus {
  const hints: StatusHints = {
    pendingKind: thread.pendingRuntimeRequest?.kind ?? null,
    interactionMode: thread.interactionMode,
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
  };
  const header = mapRunStatus(thread.activityRunStatus ?? thread.status, hints);
  if (header !== "unknown") return header;
  if (latestRunStatus) return mapRunStatus(latestRunStatus, hints);
  return header;
}
