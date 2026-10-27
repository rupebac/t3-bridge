import {
  toProjectListResult,
  toThreadDetailResult,
  toThreadListResult,
  type ProjectListResult,
  type ThreadDetailResult,
  type ThreadListResult,
} from "../contracts.js";
import type { HistoryView } from "../relay-http.js";
import type { BoundedView, ShellView, TranscriptMessage } from "../protocol-v2.js";
import { newestRun } from "../watch-match.js";
import { mapRunStatus, statusOf } from "../status.js";

const CURSOR_PREFIX = "tb1.";

export interface ThreadCursor {
  src: "bounded" | "t3";
  before?: number;
  beforeMessageId?: string;
  cursor?: string;
}

export function encodeThreadCursor(cursor: ThreadCursor): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeThreadCursor(value: string | undefined): ThreadCursor | null {
  if (!value) return null;
  if (!value.startsWith(CURSOR_PREFIX)) return { src: "t3", cursor: value };
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), "base64url").toString("utf8")) as {
      src?: unknown;
      before?: unknown;
      beforeMessageId?: unknown;
      cursor?: string;
    };
    const before = Number.isInteger(parsed.before) && Number(parsed.before) >= 0 ? Number(parsed.before) : undefined;
    const beforeMessageId = typeof parsed.beforeMessageId === "string"
      && parsed.beforeMessageId.length > 0
      && parsed.beforeMessageId.length <= 2000
      ? parsed.beforeMessageId
      : undefined;
    if (parsed.src === "bounded" && (beforeMessageId || before !== undefined)) {
      return { src: "bounded", ...(beforeMessageId ? { beforeMessageId } : {}), ...(before !== undefined ? { before } : {}) };
    }
    if (parsed.src === "t3" && typeof parsed.cursor === "string" && parsed.cursor.length > 0) {
      return {
        src: "t3",
        cursor: parsed.cursor,
        ...(beforeMessageId ? { beforeMessageId } : {}),
        ...(before !== undefined ? { before } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function projectsFromShell(environmentId: string, shell: ShellView, offset = 0, limit = 20): ProjectListResult {
  const page = shell.projects.slice(offset, offset + limit);
  return toProjectListResult({
    environmentId,
    projects: page.map(project => ({
      projectId: project.projectId,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      defaultModel: project.defaultModelSelection
        ? { instanceId: project.defaultModelSelection.instanceId, model: project.defaultModelSelection.model }
        : null,
    })),
    total: shell.projects.length,
    nextOffset: offset + page.length < shell.projects.length ? offset + page.length : null,
    warnings: shell.warnings,
  });
}

export function threadsFromShell(environmentId: string, shell: ShellView, input: {
  projectId?: string;
  status?: string;
  offset?: number;
  limit?: number;
}): ThreadListResult {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;
  const rows = shell.threads
    .filter(thread => !thread.archivedAt)
    .filter(thread => !input.projectId || thread.projectId === input.projectId)
    .map(thread => ({ thread, status: statusOf(thread) }))
    .filter(row => !input.status || row.status === input.status)
    .sort((left, right) => (right.thread.updatedAt ?? "").localeCompare(left.thread.updatedAt ?? "")
      || left.thread.threadId.localeCompare(right.thread.threadId));
  const page = rows.slice(offset, offset + limit);
  return toThreadListResult({
    environmentId,
    threads: page.map(({ thread, status }) => ({
      threadId: thread.threadId,
      projectId: thread.projectId,
      title: thread.title,
      status,
      runtimeMode: thread.runtimeMode,
      updatedAt: thread.updatedAt,
      activeRunId: thread.activeRunId,
      latestRunId: thread.latestRunId,
    })),
    total: rows.length,
    nextOffset: offset + page.length < rows.length ? offset + page.length : null,
    warnings: shell.warnings,
  });
}

export const THREAD_MESSAGE_LIMIT = 20;
export const THREAD_MESSAGE_MAX = 100;
export const THREAD_TEXT_BUDGET = 60_000;

export function detailFromRead(
  environmentId: string,
  bounded: BoundedView,
  history?: HistoryView,
  limit = THREAD_MESSAGE_LIMIT,
  cursor: ThreadCursor | null = null,
  sinceMessageId?: string,
): ThreadDetailResult {
  const thread = bounded.thread;
  const usingHistory = cursor?.src === "t3";
  const full = usingHistory ? (history?.messages ?? []) : bounded.messages;
  const anchored = pageEnd(full, cursor);
  const window = full.slice(0, anchored.end);
  const paged = takeTail(window, limit);
  let messages = paged.messages;
  const warnings = [...bounded.warnings, ...(history?.warnings ?? [])];
  if (anchored.missing) warnings.push("beforeMessageId was not in this page.");
  if (sinceMessageId) {
    const index = messages.findIndex(message => message.id === sinceMessageId);
    if (index >= 0) messages = messages.slice(index + 1);
    else warnings.push("sinceMessageId was not in this page.");
  }
  let historyCursor: string | null = null;
  let hasMoreHistory = false;
  const anchor = messages[0];
  if (paged.oldestIndex > 0 && anchor) {
    historyCursor = usingHistory && cursor?.cursor
      ? encodeThreadCursor({ src: "t3", cursor: cursor.cursor, beforeMessageId: anchor.id })
      : encodeThreadCursor({ src: "bounded", beforeMessageId: anchor.id });
    hasMoreHistory = true;
  } else if (usingHistory) {
    if (history?.historyCursor) {
      historyCursor = encodeThreadCursor({ src: "t3", cursor: history.historyCursor });
      hasMoreHistory = true;
    } else if (history?.hasMoreHistory) {
      warnings.push("Older history was not returned because the server sent no cursor.");
    }
  } else if (bounded.hasMoreHistory && bounded.historyCursor) {
    historyCursor = encodeThreadCursor({ src: "t3", cursor: bounded.historyCursor });
    hasMoreHistory = true;
  }
  const pending = (bounded.runtimeRequests ?? []).find(request => request.pending);
  const latest = newestRun(bounded.runs);
  const status = thread ? statusOf(thread, latest?.status) : "unknown";
  return toThreadDetailResult({
    environmentId,
    threadId: thread?.threadId ?? "",
    projectId: thread?.projectId ?? "",
    title: thread?.title ?? "",
    status,
    runtimeMode: thread?.runtimeMode ?? null,
    interactionMode: thread?.interactionMode ?? null,
    activeRunId: thread?.activeRunId ?? null,
    latestRunId: thread?.latestRunId ?? latest?.id ?? null,
    messages: messages.map(message => ({ id: message.id, role: message.role, text: message.text })),
    historyCursor,
    hasMoreHistory,
    warnings,
    lastError: thread?.lastError ?? null,
    planReady: status === "plan_ready",
    pendingRequest: pending
      ? { id: pending.id, kind: pending.kind }
      : thread?.pendingRuntimeRequest
        ? { id: thread.pendingRuntimeRequest.id, kind: thread.pendingRuntimeRequest.kind }
        : null,
    run: latest
      ? {
        id: latest.id,
        status: mapRunStatus(latest.status),
        error: mapRunStatus(latest.status) === "failed" ? thread?.lastError ?? null : null,
      }
      : null,
  });
}

function pageEnd(full: TranscriptMessage[], cursor: ThreadCursor | null): { end: number; missing: boolean } {
  if (cursor?.beforeMessageId) {
    const index = full.findIndex(message => message.id === cursor.beforeMessageId);
    if (index >= 0) return { end: index, missing: false };
    return { end: 0, missing: true };
  }
  if (cursor?.before !== undefined) return { end: Math.min(cursor.before, full.length), missing: false };
  return { end: full.length, missing: false };
}

function takeTail(source: TranscriptMessage[], limit: number): { messages: TranscriptMessage[]; oldestIndex: number } {
  const requested = Math.min(THREAD_MESSAGE_MAX, Math.max(1, limit));
  const newestFirst: TranscriptMessage[] = [];
  let used = 0;
  let oldestIndex = source.length;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    if (!message) continue;
    if (newestFirst.length >= requested) break;
    if (newestFirst.length > 0 && used + message.text.length > THREAD_TEXT_BUDGET) break;
    newestFirst.push(message);
    used += message.text.length;
    oldestIndex = index;
  }
  if (newestFirst.length === 0) return { messages: [], oldestIndex: 0 };
  return { messages: newestFirst.reverse(), oldestIndex };
}
