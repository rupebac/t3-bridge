import { randomUUID } from "node:crypto";
import { z } from "zod";
import { toMutationAck, type MutationAck, type MutationKind } from "../contracts.js";
import { BridgeError } from "../errors.js";
import type { Store } from "../store.js";

export type MutationOutcome = MutationAck;

const runtimeModes = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
const interactionModes = ["default", "plan"] as const;
type RuntimeMode = (typeof runtimeModes)[number];
type FollowMode = "auto" | "queue" | "steer" | "restart";

/** Runtime mode for new threads when the caller omits one: T3's auto-review mode, no manual approvals. */
export const DEFAULT_LAUNCH_RUNTIME_MODE: RuntimeMode = "auto";

export interface ModelOption {
  id: string;
  value: string | boolean | number;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: ModelOption[];
}

/** Forward instanceId/model plus T3 model options (reasoningEffort, serviceTier, ...) when present. */
export function toModelSelection(input: ModelSelection): ModelSelection {
  const selection: ModelSelection = { instanceId: input.instanceId, model: input.model };
  if (Array.isArray(input.options) && input.options.length > 0) {
    selection.options = input.options.map(option => ({ id: option.id, value: option.value }));
  }
  return selection;
}

export interface ActiveRun {
  id: string;
  status: string;
}

interface JournaledCommand {
  fingerprint: string;
  method: string;
  command: Record<string, unknown>;
}

const journalSchema = z.object({
  fingerprint: z.string(),
  method: z.string(),
  command: z.record(z.string(), z.unknown()),
});

const interruptible = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** Matches the trailer the bridge appends when a send has a wakeTarget. */
export const WAKE_MARKER_PATTERN = /\[t3b-wake target=(\S+) thread=(\S+) op=(\S+)\]/;

/** `[t3b-wake target=<wakeTarget> thread=<threadId> op=<operationId>]` */
export function wakeMarker(wakeTarget: string, threadId: string, operationId: string): string {
  return `[t3b-wake target=${wakeTarget} thread=${threadId} op=${operationId}]`;
}

/** Appends the wake marker as the final line. Text is unchanged without a wakeTarget. */
export function withWakeMarker(text: string, wakeTarget: string | undefined, threadId: string, operationId: string): string {
  if (!wakeTarget) return text;
  return `${text}\n${wakeMarker(wakeTarget, threadId, operationId)}`;
}

const markerUnsafe = /[\s\[\]]/;

function checkWakeTarget(wakeTarget: string | undefined, operationId: string, threadId?: string): string | undefined {
  if (wakeTarget === undefined || wakeTarget === "") return undefined;
  if (markerUnsafe.test(wakeTarget)) {
    throw new BridgeError("invalid_input", "wakeTarget must not contain whitespace or brackets.");
  }
  if (markerUnsafe.test(operationId)) {
    throw new BridgeError("invalid_input", "operationId must not contain whitespace or brackets when wakeTarget is set.");
  }
  if (threadId !== undefined && markerUnsafe.test(threadId)) {
    throw new BridgeError("invalid_input", "threadId must not contain whitespace or brackets when wakeTarget is set.");
  }
  return wakeTarget;
}

function wakeFingerprint(wakeTarget: string | undefined): string[] {
  return wakeTarget ? [`wake:${wakeTarget}`] : [];
}

export function isInterruptibleRun(status: string): boolean {
  return interruptible.has(status);
}

export class Mutations {
  constructor(
    private store: Store,
    private rpc: (environmentId: string, method: string, payload: Record<string, unknown>) => Promise<unknown>,
    private activeRun: (environmentId: string, threadId: string) => Promise<ActiveRun | null> = async () => null,
  ) {}

  async launchThread(input: {
    operationId: string;
    environmentId: string;
    projectId: string;
    title: string;
    instructions: string;
    modelSelection: ModelSelection;
    runtimeMode?: RuntimeMode;
    interactionMode?: (typeof interactionModes)[number];
    wakeTarget?: string;
  }): Promise<MutationOutcome> {
    const runtimeMode = input.runtimeMode ?? DEFAULT_LAUNCH_RUNTIME_MODE;
    const interactionMode = input.interactionMode ?? "default";
    const wakeTarget = checkWakeTarget(input.wakeTarget, input.operationId);
    return this.dispatch({
      kind: "start_thread",
      operationId: input.operationId,
      environmentId: input.environmentId,
      fingerprint: stable(["start_thread", input.environmentId, input.projectId, input.title, input.instructions, input.modelSelection, runtimeMode, interactionMode, ...wakeFingerprint(wakeTarget)]),
      method: "orchestration.launchThread",
      build: () => {
        const threadId = randomUUID();
        const messageId = randomUUID();
        return {
          commandId: randomUUID(),
          threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: toModelSelection(input.modelSelection),
          runtimeMode,
          interactionMode,
          creationSource: "mcp",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId, text: withWakeMarker(input.instructions, wakeTarget, threadId, input.operationId), attachments: [] },
        };
      },
      runId: (command, result) => launchRunId(command, result),
    });
  }

  async sendFollowUp(input: {
    operationId: string;
    environmentId: string;
    threadId: string;
    instructions: string;
    mode?: FollowMode;
    wakeTarget?: string;
  }): Promise<MutationOutcome> {
    const mode = input.mode ?? "auto";
    const wakeTarget = checkWakeTarget(input.wakeTarget, input.operationId, input.threadId);
    return this.dispatch({
      kind: "send_message",
      operationId: input.operationId,
      environmentId: input.environmentId,
      fingerprint: stable(["send_message", input.environmentId, input.threadId, input.instructions, mode, ...wakeFingerprint(wakeTarget)]),
      method: "orchestration.dispatchCommand",
      build: async () => {
        const dispatchMode = await this.dispatchMode(input.environmentId, input.threadId, mode);
        return {
          type: "message.dispatch",
          commandId: randomUUID(),
          threadId: input.threadId,
          messageId: randomUUID(),
          text: withWakeMarker(input.instructions, wakeTarget, input.threadId, input.operationId),
          attachments: [],
          createdBy: "agent",
          creationSource: "mcp",
          ...(mode === "auto" ? { deliveryIntent: "auto" } : {}),
          dispatchMode,
        };
      },
      threadId: input.threadId,
      runId: command => followUpRunId(command),
    });
  }

  interruptRun(input: { operationId: string; environmentId: string; threadId: string; runId?: string }): Promise<MutationOutcome> {
    return this.dispatch({
      kind: "interrupt_thread",
      operationId: input.operationId,
      environmentId: input.environmentId,
      fingerprint: stable(["interrupt_thread", input.environmentId, input.threadId, input.runId ?? null]),
      method: "orchestration.dispatchCommand",
      build: async () => ({
        type: "run.interrupt",
        commandId: randomUUID(),
        threadId: input.threadId,
        runId: await this.resolveRun(input.environmentId, input.threadId, input.runId),
      }),
      threadId: input.threadId,
      runId: command => String(command.runId),
    });
  }

  setThreadModel(input: {
    operationId: string;
    environmentId: string;
    threadId: string;
    modelSelection: ModelSelection;
  }): Promise<MutationOutcome> {
    return this.simpleCommand(input, "set_thread_model", "thread.model-selection.set", {
      modelSelection: toModelSelection(input.modelSelection),
    });
  }

  setThreadRuntime(input: {
    operationId: string;
    environmentId: string;
    threadId: string;
    runtimeMode: RuntimeMode;
  }): Promise<MutationOutcome> {
    if (!runtimeModes.includes(input.runtimeMode)) {
      throw new BridgeError("invalid_input", "runtimeMode must be approval-required, auto-accept-edits, auto, or full-access.");
    }
    return this.simpleCommand(input, "set_thread_runtime", "thread.runtime-mode.set", { runtimeMode: input.runtimeMode });
  }

  renameThread(input: { operationId: string; environmentId: string; threadId: string; title: string }): Promise<MutationOutcome> {
    return this.simpleCommand(input, "rename_thread", "thread.metadata.update", { title: input.title });
  }

  private simpleCommand(
    input: { operationId: string; environmentId: string; threadId: string },
    kind: MutationKind,
    type: string,
    fields: Record<string, unknown>,
  ): Promise<MutationOutcome> {
    return this.dispatch({
      kind,
      operationId: input.operationId,
      environmentId: input.environmentId,
      fingerprint: stable([kind, input.environmentId, input.threadId, fields]),
      method: "orchestration.dispatchCommand",
      build: () => ({ type, commandId: randomUUID(), threadId: input.threadId, ...fields }),
      threadId: input.threadId,
    });
  }

  private async dispatch(input: {
    kind: MutationKind;
    operationId: string;
    environmentId: string;
    fingerprint: string;
    method: string;
    build: () => Record<string, unknown> | Promise<Record<string, unknown>>;
    threadId?: string;
    runId?: (command: Record<string, unknown>, result: unknown) => string | null;
  }): Promise<MutationOutcome> {
    const existing = journalSchema.safeParse(await this.store.getOperation(input.operationId));
    let journal: JournaledCommand;
    if (existing.success) {
      if (existing.data.fingerprint !== input.fingerprint) {
        throw new BridgeError("operation_conflict", "operation_conflict: this operationId was already saved with different arguments.");
      }
      journal = existing.data;
    } else {
      journal = { fingerprint: input.fingerprint, method: input.method, command: await input.build() };
      await this.store.recordOperation(input.operationId, journal);
    }
    let result: unknown;
    try {
      result = await this.rpc(input.environmentId, journal.method, journal.command);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("operation_incomplete", "The operation did not finish confirming acceptance. Retry the same operationId.");
    }
    const threadId = input.threadId ?? String(journal.command.threadId ?? "");
    const runId = input.runId ? input.runId(journal.command, result) : null;
    return toMutationAck({
      kind: input.kind,
      operationId: input.operationId,
      environmentId: input.environmentId,
      threadId,
      runId,
      userMessageId: commandMessageId(journal.command),
      accepted: true,
      watched: false,
    });
  }

  private async dispatchMode(environmentId: string, threadId: string, mode: FollowMode): Promise<Record<string, unknown>> {
    if (mode === "queue") return { type: "queue_after_active" };
    if (mode === "steer" || mode === "restart") {
      const runId = await this.resolveRun(environmentId, threadId);
      return { type: mode === "steer" ? "steer_active" : "restart_active", targetRunId: runId };
    }
    return { type: "start_immediately" };
  }

  private async resolveRun(environmentId: string, threadId: string, explicit?: string): Promise<string> {
    if (explicit) return explicit;
    const active = await this.activeRun(environmentId, threadId);
    if (!active) throw new BridgeError("no_active_run", "There is no running run to target.");
    if (!interruptible.has(active.status)) {
      throw new BridgeError("run_not_interruptible", "The selected run is not interruptible.");
    }
    return active.id;
  }
}

function launchRunId(command: Record<string, unknown>, result: unknown): string | null {
  const threadId = String(command.threadId);
  const messageId = commandMessageId(command);
  const record = asRecord(result);
  if (!record) return null;
  if (typeof record.threadId === "string" && record.threadId !== threadId) {
    throw new BridgeError("identity_mismatch", "The launch response names another thread.");
  }
  const projection = asRecord(record.projection);
  const runs = projection && Array.isArray(projection.runs) ? projection.runs : [];
  for (const row of runs) {
    const parsed = z.object({
      id: z.string().min(1),
      userMessageId: z.string().nullish(),
    }).safeParse(row);
    if (!parsed.success) continue;
    if (messageId && parsed.data.userMessageId === messageId) return parsed.data.id;
  }
  return null;
}

function followUpRunId(command: Record<string, unknown>): string | null {
  const mode = asRecord(command.dispatchMode);
  if (!mode || mode.type !== "steer_active") return null;
  return typeof mode.targetRunId === "string" ? mode.targetRunId : null;
}

function commandMessageId(command: Record<string, unknown>): string | null {
  const initial = asRecord(command.initialMessage);
  if (initial && typeof initial.messageId === "string") return initial.messageId;
  return typeof command.messageId === "string" ? command.messageId : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
