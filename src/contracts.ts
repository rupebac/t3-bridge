export const BRIDGE_VERSION = "0.1.0" as const;
export const MESSAGE_TEXT_LIMIT = 8_000;
export const SUMMARY_LIMIT = 500;

const TRUNCATED = "\n[truncated]";

export function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const keep = Math.max(0, limit - TRUNCATED.length);
  return `${text.slice(0, keep)}${TRUNCATED}`;
}

export interface EnvironmentSummary {
  environmentId: string;
  label: string;
  endpoint: string;
  availability: "unchecked" | "online" | "offline" | "unavailable";
}

export interface EnvironmentListResult {
  bridgeVersion: typeof BRIDGE_VERSION;
  environments: EnvironmentSummary[];
  total: number;
  nextOffset: number | null;
  warnings: string[];
}

export interface ModelRef {
  instanceId: string;
  model: string;
}

export interface ProjectSummary {
  projectId: string;
  title: string;
  workspaceRoot: string;
  defaultModel: ModelRef | null;
}

export interface ProjectListResult {
  bridgeVersion: typeof BRIDGE_VERSION;
  environmentId: string;
  projects: ProjectSummary[];
  total: number;
  nextOffset: number | null;
  warnings: string[];
}

export interface ThreadListItem {
  threadId: string;
  projectId: string;
  title: string;
  status: string;
  runtimeMode: string | null;
  updatedAt: string | null;
  activeRunId: string | null;
  latestRunId: string | null;
}

export interface ThreadListResult {
  bridgeVersion: typeof BRIDGE_VERSION;
  environmentId: string;
  threads: ThreadListItem[];
  total: number;
  nextOffset: number | null;
  warnings: string[];
}

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}

export interface ThreadDetailResult {
  bridgeVersion: typeof BRIDGE_VERSION;
  environmentId: string;
  threadId: string;
  projectId: string;
  title: string;
  status: string;
  runtimeMode: string | null;
  interactionMode: string | null;
  activeRunId: string | null;
  latestRunId: string | null;
  messages: ThreadMessage[];
  historyCursor: string | null;
  hasMoreHistory: boolean;
  warnings: string[];
  lastError: string | null;
  planReady: boolean;
  pendingRequest: { id: string; kind: string } | null;
  run: { id: string; status: string; error: string | null } | null;
}

export type MutationKind =
  | "start_thread"
  | "send_message"
  | "interrupt_thread"
  | "set_thread_model"
  | "set_thread_runtime"
  | "rename_thread";

export interface MutationAck {
  bridgeVersion: typeof BRIDGE_VERSION;
  kind: MutationKind;
  operationId: string;
  environmentId: string;
  threadId: string;
  runId: string | null;
  userMessageId: string | null;
  accepted: boolean;
  watched: boolean;
  warnings?: string[];
}

function warningsOf(warnings: string[] | undefined): string[] {
  return (warnings ?? []).map(warning => clipText(warning, 500));
}

const ID_LIMIT = 2_000;

function clipId(value: string): string {
  return value.length <= ID_LIMIT ? value : value.slice(0, ID_LIMIT);
}

function modelOf(model: (ModelRef & Record<string, unknown>) | null | undefined): ModelRef | null {
  if (!model) return null;
  return { instanceId: clipId(model.instanceId), model: clipId(model.model) };
}

export function toEnvironmentListResult(input: {
  environments: Array<EnvironmentSummary & Record<string, unknown>>;
  total: number;
  nextOffset: number | null;
  warnings?: string[];
}): EnvironmentListResult {
  return {
    bridgeVersion: BRIDGE_VERSION,
    environments: input.environments.map(environment => ({
      environmentId: environment.environmentId,
      label: clipText(environment.label, 200),
      endpoint: environment.endpoint,
      availability: environment.availability,
    })),
    total: input.total,
    nextOffset: input.nextOffset,
    warnings: warningsOf(input.warnings),
  };
}

export function toProjectListResult(input: {
  environmentId: string;
  projects: Array<{
    projectId: string;
    title: string;
    workspaceRoot: string;
    defaultModel: (ModelRef & Record<string, unknown>) | null;
  }>;
  total: number;
  nextOffset: number | null;
  warnings?: string[];
}): ProjectListResult {
  return {
    bridgeVersion: BRIDGE_VERSION,
    environmentId: input.environmentId,
    projects: input.projects.map(project => ({
      projectId: project.projectId,
      title: clipText(project.title, 200),
      workspaceRoot: clipText(project.workspaceRoot, 2000),
      defaultModel: modelOf(project.defaultModel),
    })),
    total: input.total,
    nextOffset: input.nextOffset,
    warnings: warningsOf(input.warnings),
  };
}

export function toThreadListResult(input: {
  environmentId: string;
  threads: Array<ThreadListItem & Record<string, unknown>>;
  total: number;
  nextOffset: number | null;
  warnings?: string[];
}): ThreadListResult {
  return {
    bridgeVersion: BRIDGE_VERSION,
    environmentId: input.environmentId,
    threads: input.threads.map(thread => ({
      threadId: thread.threadId,
      projectId: thread.projectId,
      title: clipText(thread.title, 200),
      status: thread.status,
      runtimeMode: thread.runtimeMode,
      updatedAt: thread.updatedAt,
      activeRunId: thread.activeRunId,
      latestRunId: thread.latestRunId,
    })),
    total: input.total,
    nextOffset: input.nextOffset,
    warnings: warningsOf(input.warnings),
  };
}

const roles = new Set<ThreadMessage["role"]>(["user", "assistant", "system"]);

export function toThreadDetailResult(input: {
  environmentId: string;
  threadId: string;
  projectId: string;
  title: string;
  status: string;
  runtimeMode: string | null;
  interactionMode: string | null;
  activeRunId: string | null;
  latestRunId: string | null;
  messages: Array<{ id: string; role: string; text: string } & Record<string, unknown>>;
  historyCursor: string | null;
  hasMoreHistory: boolean;
  warnings?: string[];
  lastError: string | null;
  planReady: boolean;
  pendingRequest: { id: string; kind: string } | null;
  run: { id: string; status: string; error: string | null } | null;
}): ThreadDetailResult {
  const messages: ThreadMessage[] = [];
  for (const message of input.messages) {
    if (!roles.has(message.role as ThreadMessage["role"])) continue;
    messages.push({
      id: message.id,
      role: message.role as ThreadMessage["role"],
      text: clipText(message.text, MESSAGE_TEXT_LIMIT),
    });
  }
  return {
    bridgeVersion: BRIDGE_VERSION,
    environmentId: input.environmentId,
    threadId: input.threadId,
    projectId: input.projectId,
    title: clipText(input.title, 200),
    status: input.status,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    activeRunId: input.activeRunId,
    latestRunId: input.latestRunId,
    messages,
    historyCursor: input.historyCursor,
    hasMoreHistory: input.hasMoreHistory,
    warnings: warningsOf(input.warnings),
    lastError: input.lastError ? clipText(input.lastError, 500) : null,
    planReady: input.planReady,
    pendingRequest: input.pendingRequest ? { id: input.pendingRequest.id, kind: input.pendingRequest.kind } : null,
    run: input.run ? { id: input.run.id, status: input.run.status, error: input.run.error ? clipText(input.run.error, 500) : null } : null,
  };
}

export function toMutationAck(input: {
  kind: MutationKind;
  operationId: string;
  environmentId: string;
  threadId: string;
  runId: string | null;
  userMessageId?: string | null;
  accepted: boolean;
  watched?: boolean;
  warnings?: string[];
} & Record<string, unknown>): MutationAck {
  const ack: MutationAck = {
    bridgeVersion: BRIDGE_VERSION,
    kind: input.kind,
    operationId: input.operationId,
    environmentId: input.environmentId,
    threadId: input.threadId,
    runId: input.runId,
    userMessageId: input.userMessageId ?? null,
    accepted: input.accepted,
    watched: input.watched ?? false,
  };
  const warnings = warningsOf(input.warnings);
  if (warnings.length > 0) ack.warnings = warnings;
  return ack;
}
