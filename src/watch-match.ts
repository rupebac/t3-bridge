import type { RunView, RuntimeRequestView, ThreadSummary, TranscriptMessage } from "./protocol-v2.js";
import { isAttention, isTerminal, mapRunStatus, statusOf, type AttentionStatus } from "./status.js";

export interface WatchTarget {
  threadId: string;
  title: string | null;
  projectId: string | null;
  runId: string | null;
  userMessageId: string | null;
  baselineRunId: string | null;
  baselineSet: boolean;
  /** When false, a terminal runId is not used until the watched message id appears. */
  allowTerminalRunFallback?: boolean;
}

export interface WatchedSnapshot {
  runId: string | null;
  status: string;
  summary: string;
  title: string | null;
  projectId: string | null;
  threadId: string | null;
  planReady?: boolean;
  attentionKind?: string | null;
  error?: string | null;
}

export interface BareWatchTarget {
  runId: string | null;
  baselineRunId: string | null;
  baselineSet: true;
}

type BoundedSlice = {
  thread: ThreadSummary | null;
  runs: RunView[];
  messages: TranscriptMessage[];
  runtimeRequests?: RuntimeRequestView[];
};

export function newestRun(runs: RunView[]): RunView | undefined {
  return [...runs].sort((left, right) => (right.ordinal ?? 0) - (left.ordinal ?? 0) || right.id.localeCompare(left.id))[0];
}

/**
 * A bare watch follows the run that is already in progress.
 * When the thread is idle, the newest finished run is only a baseline.
 */
export function bareWatchTarget(bounded: { thread: ThreadSummary | null; runs: RunView[] }): BareWatchTarget {
  const activeId = bounded.thread?.activeRunId ?? null;
  if (activeId) {
    const active = bounded.runs.find(run => run.id === activeId);
    if (!active || !isTerminal(mapRunStatus(active.status))) {
      return { runId: activeId, baselineRunId: null, baselineSet: true };
    }
  }
  const newest = newestRun(bounded.runs);
  if (newest && !isTerminal(mapRunStatus(newest.status))) {
    return { runId: newest.id, baselineRunId: null, baselineSet: true };
  }
  return {
    runId: null,
    baselineRunId: newest?.id ?? bounded.thread?.latestRunId ?? null,
    baselineSet: true,
  };
}

/**
 * Match the watched prompt's run. Never substitutes the latest run.
 * A bare watch (no run id and no message id) only accepts a run newer than the baseline.
 * Terminal run status wins over an attention overlay.
 */
export function selectWatchedRun(watch: WatchTarget, bounded: BoundedSlice): WatchedSnapshot {
  const run = findRun(watch, bounded.runs);
  const title = bounded.thread?.title ?? watch.title;
  const projectId = bounded.thread?.projectId ?? watch.projectId;
  const threadId = bounded.thread?.threadId ?? watch.threadId;
  if (!run) {
    return { runId: null, status: "pending", summary: "", title, projectId, threadId, planReady: false };
  }
  const runStatus = mapRunStatus(run.status);
  let status = runStatus;
  let attentionKind: string | null = null;
  if (!isTerminal(runStatus)) {
    const overlay = attentionFor(run, bounded);
    if (overlay) {
      status = overlay.status;
      attentionKind = overlay.kind;
    }
  }
  const planReady = Boolean(
    bounded.thread
    && bounded.thread.interactionMode === "plan"
    && bounded.thread.hasActionableProposedPlan
    && (runStatus === "finished" || status === "plan_ready"),
  );
  const summary = [...bounded.messages].reverse().find(message => message.role === "assistant")?.text ?? "";
  const error = runStatus === "failed" ? bounded.thread?.lastError ?? null : null;
  return { runId: run.id, status, summary, title, projectId, threadId, planReady, attentionKind, error };
}

export function watchState(watch: {
  expiresAt?: string | null;
  armedAt: string;
  lastStatus?: string | null;
}, now = Date.now()): "pending" | "running" | "attention" | "fired" | "expired" {
  const expires = watch.expiresAt ? Date.parse(watch.expiresAt) : Date.parse(watch.armedAt) + 24 * 60 * 60 * 1000;
  if (Number.isFinite(expires) && expires <= now) return "expired";
  const status = watch.lastStatus ?? null;
  if (status && isTerminal(status)) return "fired";
  if (status && isAttention(status)) return "attention";
  if (status && status !== "pending" && status !== "unknown" && status !== "idle") return "running";
  return "pending";
}

function findRun(watch: WatchTarget, runs: RunView[]): RunView | undefined {
  if (watch.userMessageId) {
    const byMessage = runs.find(run => run.userMessageId === watch.userMessageId);
    if (byMessage) return byMessage;
    if (!watch.runId) return undefined;
    const target = runs.find(run => run.id === watch.runId);
    if (!target) return undefined;
    if (!isTerminal(mapRunStatus(target.status))) return target;
    if (runs.some(run => isNewerThanBaseline(target.id, target, run, runs))) return undefined;
    if (watch.allowTerminalRunFallback === false) return undefined;
    return target;
  }
  if (watch.runId) return runs.find(run => run.id === watch.runId);
  if (!watch.baselineSet) return undefined;
  const baseline = watch.baselineRunId ? runs.find(run => run.id === watch.baselineRunId) : undefined;
  const newer = runs.filter(run => isNewerThanBaseline(watch.baselineRunId, baseline, run, runs));
  return newestRun(newer);
}

/**
 * A higher ordinal is newer. Without ordinals, a later array position or a later
 * createdAt is newer. A run that appears earlier in the array is never newer.
 */
function isNewerThanBaseline(baselineRunId: string | null, baseline: RunView | undefined, run: RunView, runs: RunView[]): boolean {
  if (!baselineRunId) return true;
  if (run.id === baselineRunId) return false;
  if (baseline?.ordinal != null && run.ordinal != null) return run.ordinal > baseline.ordinal;
  const baselineIndex = runs.findIndex(candidate => candidate.id === baselineRunId);
  const runIndex = runs.findIndex(candidate => candidate.id === run.id);
  if (baselineIndex >= 0 && runIndex >= 0) {
    if (runIndex < baselineIndex) return false;
    if (runIndex > baselineIndex) return true;
  }
  const baselineAt = stamp(baseline?.createdAt);
  const runAt = stamp(run.createdAt);
  if (baselineAt != null && runAt != null) return runAt > baselineAt;
  return baselineIndex < 0;
}

function stamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function attentionFor(run: RunView, bounded: BoundedSlice): { status: AttentionStatus; kind: string } | null {
  const pending = (bounded.runtimeRequests ?? []).filter(request => request.pending);
  const targeted = pending.find(request => request.runId === run.id);
  const current = isWatchedRunCurrent(run, bounded);
  const unscoped = current ? pending.find(request => !request.runId) : undefined;
  const headerKind = current ? bounded.thread?.pendingRuntimeRequest?.kind : undefined;
  const kind = targeted?.kind ?? unscoped?.kind ?? headerKind;
  if (!kind) {
    if (!current || !bounded.thread) return null;
    const overlay = statusOf(bounded.thread);
    if (!isAttention(overlay)) return null;
    return { status: overlay, kind: headerKind ?? overlay };
  }
  const status = mapRunStatus(run.status, {
    pendingKind: kind,
    interactionMode: bounded.thread?.interactionMode,
    hasActionableProposedPlan: bounded.thread?.hasActionableProposedPlan,
  });
  if (!isAttention(status)) return null;
  return { status, kind };
}

function isWatchedRunCurrent(run: RunView, bounded: BoundedSlice): boolean {
  const active = bounded.thread?.activeRunId;
  if (active) return active === run.id;
  const open = bounded.runs.filter(candidate => !isTerminal(mapRunStatus(candidate.status)));
  return newestRun(open)?.id === run.id;
}
