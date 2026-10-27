import { z } from "zod";
import { clipText } from "./contracts.js";

/** Live orchestration v2 identifiers are longer than the 200-character cap older bridges enforced. */
export const idSchema = z.string().min(1).max(2000);

const optionalId = idSchema.nullable().optional().catch(null);

/** Non-identity fields never reject the row. Empty strings and odd shapes become null. */
const looseText = (limit: number) => z.string().nullish().transform(value => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? clipText(trimmed, limit) : trimmed;
}).catch(null);

const looseLabel = looseText(80);
const looseStamp = looseText(80);
const looseError = z.string().nullish().transform(value => (typeof value === "string" ? clipText(value, 8_000) : null)).catch(null);

const pendingRequestSchema = z.object({
  id: idSchema,
  kind: z.string().min(1).max(80),
}).nullish().catch(null);

const modelSelectionSchema = z.object({
  instanceId: idSchema,
  model: idSchema,
}).nullish().catch(null);

const looseTitle = z.union([z.string(), z.null()]).transform(value => (value === null ? "" : clipText(value, 20_000)));

const threadRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  title: looseTitle,
  runtimeMode: looseLabel,
  interactionMode: looseLabel,
  status: looseLabel,
  createdAt: looseStamp,
  updatedAt: looseStamp,
  archivedAt: looseStamp,
  deletedAt: looseStamp,
  activeRunId: optionalId,
  latestRunId: optionalId,
  activityRunStatus: looseLabel,
  lastError: looseError,
  pendingRuntimeRequest: pendingRequestSchema,
  hasActionableProposedPlan: z.boolean().optional().catch(undefined),
  modelSelection: modelSelectionSchema,
  latestUserMessageAt: looseStamp,
});

export interface ModelSelectionView {
  instanceId: string;
  model: string;
}

export interface PendingRequestView {
  id: string;
  kind: string;
}

export interface ThreadSummary {
  threadId: string;
  projectId: string;
  title: string;
  runtimeMode: string | null;
  interactionMode: string | null;
  status: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  activeRunId: string | null;
  latestRunId: string | null;
  activityRunStatus: string | null;
  lastError: string | null;
  pendingRuntimeRequest: PendingRequestView | null;
  hasActionableProposedPlan: boolean;
  modelSelection: ModelSelectionView | null;
  latestUserMessageAt: string | null;
}

export interface ProjectView {
  projectId: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection: ModelSelectionView | null;
  defaultThreadEnvMode: string | null;
}

export interface ShellView {
  schemaVersion: number | null;
  snapshotSequence: number | null;
  projects: ProjectView[];
  threads: ThreadSummary[];
  warnings: string[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function blank(value: string | null | undefined): string | null {
  return value ?? null;
}

export function mapThreadRow(raw: unknown): ThreadSummary | null {
  const parsed = threadRowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  return {
    threadId: row.id,
    projectId: row.projectId,
    title: row.title,
    runtimeMode: blank(row.runtimeMode),
    interactionMode: blank(row.interactionMode),
    status: blank(row.status),
    createdAt: blank(row.createdAt),
    updatedAt: blank(row.updatedAt),
    archivedAt: blank(row.archivedAt),
    deletedAt: blank(row.deletedAt),
    activeRunId: blank(row.activeRunId),
    latestRunId: blank(row.latestRunId),
    activityRunStatus: blank(row.activityRunStatus),
    lastError: row.lastError ?? null,
    pendingRuntimeRequest: row.pendingRuntimeRequest ?? null,
    hasActionableProposedPlan: row.hasActionableProposedPlan ?? false,
    modelSelection: row.modelSelection ?? null,
    latestUserMessageAt: blank(row.latestUserMessageAt),
  };
}

const projectSchema = z.object({
  id: idSchema,
  title: looseTitle,
  workspaceRoot: z.string().nullish().transform(value => (typeof value === "string" ? clipText(value, 20_000) : "")).catch(""),
  defaultModelSelection: modelSelectionSchema,
  defaultThreadEnvMode: looseLabel,
});

export function mapProject(raw: unknown): ProjectView | null {
  const parsed = projectSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    projectId: parsed.data.id,
    title: parsed.data.title,
    workspaceRoot: parsed.data.workspaceRoot ?? "",
    defaultModelSelection: parsed.data.defaultModelSelection ?? null,
    defaultThreadEnvMode: blank(parsed.data.defaultThreadEnvMode),
  };
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

export function parseShell(raw: unknown): ParseResult<ShellView> {
  const record = asRecord(raw);
  if (!record) return { ok: false, error: "shell_not_object" };
  const warnings: string[] = [];
  const projects: ProjectView[] = [];
  const projectRows = Array.isArray(record.projects) ? record.projects : [];
  if (!Array.isArray(record.projects)) warnings.push("Shell response did not include a projects array.");
  projectRows.forEach((row, index) => {
    const mapped = mapProject(row);
    if (!mapped) warnings.push(`Skipped project row ${index}.`);
    else projects.push(mapped);
  });
  const threads: ThreadSummary[] = [];
  const threadRows = Array.isArray(record.threads) ? record.threads : [];
  if (!Array.isArray(record.threads)) warnings.push("Shell response did not include a threads array.");
  threadRows.forEach((row, index) => {
    const mapped = mapThreadRow(row);
    if (!mapped) {
      warnings.push(`Skipped thread row ${index}.`);
      return;
    }
    if (mapped.deletedAt) return;
    threads.push(mapped);
  });
  return {
    ok: true,
    value: {
      schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : null,
      snapshotSequence: typeof record.snapshotSequence === "number" ? record.snapshotSequence : null,
      projects,
      threads,
      warnings,
    },
  };
}

const looseOrdinal = z.unknown().optional().transform(value => {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(number) ? number : null;
}).catch(null);

const looseStatus = z.unknown().optional().transform(value => {
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim().slice(0, 80);
  return trimmed || "unknown";
}).catch("unknown");

const runSchema = z.object({
  id: idSchema,
  ordinal: looseOrdinal,
  status: looseStatus,
  userMessageId: optionalId,
  createdAt: looseStamp,
});

const turnItemSchema = z.object({
  id: idSchema,
  type: z.string().min(1).max(80),
  text: z.unknown().optional().transform(value => (typeof value === "string" ? clipText(value, 200_000) : undefined)),
  messageId: idSchema.optional(),
});

const runtimeRequestSchema = z.object({
  id: idSchema,
  kind: z.string().min(1).max(80),
  runId: optionalId,
  resolved: z.boolean().optional(),
  resolvedAt: z.string().nullish(),
  state: z.string().nullish(),
  status: z.string().nullish(),
});

function isOpenRequest(label: string): boolean {
  return label === "pending" || label === "open" || label === "waiting" || label === "requested" || label.startsWith("awaiting");
}

/** Pending only when the row is explicitly still open. Any other status counts as resolved. */
function requestPending(row: { resolved?: boolean; resolvedAt?: string | null; state?: string | null; status?: string | null }): boolean {
  if (row.resolved === true) return false;
  if (typeof row.resolvedAt === "string" && row.resolvedAt.trim()) return false;
  const labels = [row.state, row.status]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(value => value.trim().toLowerCase());
  if (labels.length === 0) return true;
  return labels.every(label => isOpenRequest(label));
}

export interface RunView {
  id: string;
  ordinal: number | null;
  status: string;
  userMessageId: string | null;
  createdAt?: string | null;
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}

export interface RuntimeRequestView {
  id: string;
  kind: string;
  runId: string | null;
  pending: boolean;
}

export interface BoundedView {
  snapshotSequence: number | null;
  thread: ThreadSummary | null;
  runs: RunView[];
  messages: TranscriptMessage[];
  runtimeRequests: RuntimeRequestView[];
  historyCursor: string | null;
  hasMoreHistory: boolean;
  warnings: string[];
}

const messageRoles: Record<string, TranscriptMessage["role"]> = {
  user_message: "user",
  assistant_message: "assistant",
  system_message: "system",
};

function readMessages(rows: unknown[], warnings: string[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  rows.forEach((row, index) => {
    const record = asRecord(row);
    const item = record && "item" in record ? record.item : row;
    const parsed = turnItemSchema.safeParse(item);
    if (!parsed.success) {
      const type = asRecord(item)?.type;
      if (type === "user_message" || type === "assistant_message" || type === "system_message") {
        warnings.push(`Skipped message row ${index}.`);
      }
      return;
    }
    const role = messageRoles[parsed.data.type];
    if (!role || parsed.data.text === undefined) return;
    messages.push({ id: parsed.data.messageId ?? parsed.data.id, role, text: parsed.data.text });
  });
  return messages;
}

export function parseBounded(raw: unknown): ParseResult<BoundedView> {
  const record = asRecord(raw);
  if (!record) return { ok: false, error: "bounded_not_object" };
  const warnings: string[] = [];
  const projection = asRecord(record.projection) ?? {};
  if (!asRecord(record.projection)) warnings.push("Bounded response did not include a projection.");
  const thread = mapThreadRow(projection.thread);
  if (projection.thread !== undefined && !thread) warnings.push("Skipped the bounded thread header.");
  const runs: RunView[] = [];
  const runRows = Array.isArray(projection.runs) ? projection.runs : [];
  runRows.forEach((row, index) => {
    const parsed = runSchema.safeParse(row);
    if (!parsed.success) {
      warnings.push(`Skipped run row ${index}.`);
      return;
    }
    runs.push({
      id: parsed.data.id,
      ordinal: parsed.data.ordinal ?? null,
      status: parsed.data.status,
      userMessageId: blank(parsed.data.userMessageId),
      createdAt: parsed.data.createdAt ?? null,
    });
  });
  const runtimeRequests: RuntimeRequestView[] = [];
  const requestRows = Array.isArray(projection.runtimeRequests) ? projection.runtimeRequests : [];
  requestRows.forEach((row, index) => {
    const parsed = runtimeRequestSchema.safeParse(row);
    if (!parsed.success) {
      warnings.push(`Skipped runtime request row ${index}.`);
      return;
    }
    runtimeRequests.push({
      id: parsed.data.id,
      kind: parsed.data.kind,
      runId: blank(parsed.data.runId),
      pending: requestPending(parsed.data),
    });
  });
  const rows = Array.isArray(projection.visibleTurnItems) ? projection.visibleTurnItems : [];
  return {
    ok: true,
    value: {
      snapshotSequence: typeof record.snapshotSequence === "number" ? record.snapshotSequence : null,
      thread,
      runs,
      messages: readMessages(rows, warnings),
      runtimeRequests,
      historyCursor: typeof record.historyCursor === "string" ? record.historyCursor : null,
      hasMoreHistory: record.hasMoreHistory === true,
      warnings,
    },
  };
}

export function parseHistory(raw: unknown): ParseResult<Pick<BoundedView, "snapshotSequence" | "messages" | "historyCursor" | "hasMoreHistory" | "warnings">> {
  const record = asRecord(raw);
  if (!record) return { ok: false, error: "history_not_object" };
  const warnings: string[] = [];
  const rows = Array.isArray(record.items) ? record.items : [];
  if (!Array.isArray(record.items)) warnings.push("History response did not include an items array.");
  return {
    ok: true,
    value: {
      snapshotSequence: typeof record.snapshotSequence === "number" ? record.snapshotSequence : null,
      messages: readMessages(rows, warnings),
      historyCursor: typeof record.nextCursor === "string" ? record.nextCursor : null,
      hasMoreHistory: record.hasMoreHistory === true,
      warnings,
    },
  };
}
