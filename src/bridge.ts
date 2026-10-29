import { BRIDGE_VERSION, toEnvironmentListResult, toMutationAck, type EnvironmentListResult, type MutationAck, type ProjectListResult, type ThreadDetailResult, type ThreadListResult } from "./contracts.js";
import { ClerkAuth } from "./auth.js";
import { readConfig, type Config } from "./config.js";
import { Connect, type EnvironmentPage } from "./connect.js";
import { BridgeError } from "./errors.js";
import { Http } from "./http.js";
import { fetchBounded, fetchBoundedDocument, fetchHistory, fetchHistoryDocument, fetchShell, fetchShellDocument, type HistoryView, type RelayDocument, type RelayEnv } from "./relay-http.js";
import { environmentRpc } from "./rpc.js";
import type { ShellView, BoundedView } from "./protocol-v2.js";
import { Store } from "./store.js";
import { decodeThreadCursor, detailFromRead, projectsFromShell, threadsFromShell } from "./tools/read.js";
import { isInterruptibleRun, Mutations, type ActiveRun } from "./tools/mutate.js";
import type { WatchListResult } from "./server.js";
import { bareWatchTarget, selectWatchedRun, watchState } from "./watch-match.js";
import { isAttention, isTerminal } from "./status.js";
import { Watcher } from "./watch.js";
import { DEFAULT_WEBHOOK_NAME, parseWebhookName, webhookUrl } from "./webhook.js";
import { redactFixture } from "./redact.js";
import { VERSION } from "./version.js";

export interface BridgePorts {
  defaultEnvironmentId: string;
  listLinked: () => Promise<EnvironmentPage>;
  probe: (environmentId: string) => Promise<"online" | "offline" | "unavailable">;
  shell: (environmentId: string) => Promise<ShellView>;
  bounded: (environmentId: string, threadId: string) => Promise<BoundedView>;
  history: (environmentId: string, threadId: string, cursor?: string) => Promise<HistoryView>;
  shellDocument?: (environmentId: string) => Promise<RelayDocument<ShellView>>;
  boundedDocument?: (environmentId: string, threadId: string) => Promise<RelayDocument<BoundedView>>;
  historyDocument?: (environmentId: string, threadId: string, cursor?: string) => Promise<RelayDocument<HistoryView>>;
  mutations: Mutations;
  watcher: Watcher;
  store: Store;
  prepare?: (environmentId: string) => Promise<void>;
  credentialExpiry?: (environmentId: string) => string | null;
  sleep?: (ms: number) => Promise<void>;
}

interface ModelInput {
  instanceId: string;
  model: string;
  options?: ModelOption[];
}

interface ModelOption {
  id: string;
  value: string | boolean | number;
}

export class Bridge {
  constructor(private ports: BridgePorts) {}

  private env(environmentId?: string): string {
    return environmentId || this.ports.defaultEnvironmentId;
  }

  async listEnvironments(input: { offset?: number; limit?: number; checkAvailability?: boolean } = {}): Promise<EnvironmentListResult> {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 20;
    const linked = await this.ports.listLinked();
    const page = linked.environments.slice(offset, offset + limit);
    const environments = [];
    for (const environment of page) {
      let availability: "unchecked" | "online" | "offline" | "unavailable" = "unchecked";
      if (input.checkAvailability) availability = await this.ports.probe(environment.environmentId);
      environments.push({
        environmentId: environment.environmentId,
        label: environment.label,
        endpoint: environment.httpBaseUrl,
        availability,
      });
    }
    return toEnvironmentListResult({
      environments,
      total: linked.environments.length,
      nextOffset: offset + page.length < linked.environments.length ? offset + page.length : null,
      warnings: linked.warnings,
    });
  }

  async listProjects(input: { environmentId?: string; offset?: number; limit?: number } = {}): Promise<ProjectListResult> {
    const environmentId = this.env(input.environmentId);
    return projectsFromShell(environmentId, await this.ports.shell(environmentId), input.offset ?? 0, input.limit ?? 20);
  }

  async listThreads(input: { environmentId?: string; projectId?: string; status?: string; offset?: number; limit?: number } = {}): Promise<ThreadListResult> {
    const environmentId = this.env(input.environmentId);
    return threadsFromShell(environmentId, await this.ports.shell(environmentId), input);
  }

  async getThread(input: { environmentId?: string; threadId: string; beforeCursor?: string; limit?: number; sinceMessageId?: string }): Promise<ThreadDetailResult> {
    const environmentId = this.env(input.environmentId);
    const bounded = await this.ports.bounded(environmentId, input.threadId);
    if (bounded.thread && bounded.thread.threadId !== input.threadId) {
      throw new BridgeError("identity_mismatch", "The response names another thread.");
    }
    const cursor = input.beforeCursor ? decodeThreadCursor(input.beforeCursor) : null;
    if (input.beforeCursor && !cursor) throw new BridgeError("invalid_input", "beforeCursor is not a history cursor.");
    const history = cursor?.src === "t3" && cursor.cursor
      ? await this.ports.history(environmentId, input.threadId, cursor.cursor)
      : undefined;
    const detail = detailFromRead(environmentId, bounded, history, input.limit, cursor, input.sinceMessageId);
    if (!detail.threadId) throw new BridgeError("thread_not_found", "This thread was not in the snapshot.");
    return detail;
  }

  async startThread(input: {
    operationId: string;
    environmentId?: string;
    projectId: string;
    title: string;
    instructions: string;
    modelSelection?: ModelInput;
    runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
    interactionMode?: "default" | "plan";
    watch?: boolean;
    notifyOnAttention?: boolean;
    wakeTarget?: string;
  }): Promise<MutationAck> {
    const environmentId = this.env(input.environmentId);
    await this.ports.prepare?.(environmentId);
    const shell = await this.ports.shell(environmentId);
    const project = shell.projects.find(candidate => candidate.projectId === input.projectId);
    if (!project) throw new BridgeError("project_not_found", "This project does not exist on the selected environment.");
    if (project.defaultThreadEnvMode === "worktree") {
      throw new BridgeError("worktree_unsupported", "This project defaults to worktrees. The bridge does not create worktrees.");
    }
    const modelSelection = input.modelSelection ?? project.defaultModelSelection ?? undefined;
    if (!modelSelection) throw new BridgeError("model_required", "This project has no default model. Pass modelSelection.");
    const ack = await this.ports.mutations.launchThread({
      operationId: input.operationId,
      environmentId,
      projectId: input.projectId,
      title: input.title,
      instructions: input.instructions,
      modelSelection,
      ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
      ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    });
    const armed = await this.maybeWatch(input.watch, {
      environmentId,
      projectId: input.projectId,
      threadId: ack.threadId,
      title: input.title,
      runId: ack.runId,
      userMessageId: ack.userMessageId,
      baselineRunId: null,
      baselineSet: true,
      notifyOnAttention: input.notifyOnAttention ?? false,
      wakeTarget: input.wakeTarget,
    });
    return toMutationAck({ ...ack, watched: armed.watched, warnings: armed.warnings });
  }

  async sendMessage(input: {
    operationId: string;
    environmentId?: string;
    threadId: string;
    instructions: string;
    mode?: "auto" | "queue" | "steer" | "restart";
    watch?: boolean;
    notifyOnAttention?: boolean;
    wakeTarget?: string;
  }): Promise<MutationAck> {
    const environmentId = this.env(input.environmentId);
    await this.ports.prepare?.(environmentId);
    const ack = await this.ports.mutations.sendFollowUp({
      operationId: input.operationId,
      environmentId,
      threadId: input.threadId,
      instructions: input.instructions,
      ...(input.mode ? { mode: input.mode } : {}),
    });
    const armed = await this.maybeWatch(input.watch, {
      environmentId,
      projectId: null,
      threadId: input.threadId,
      title: null,
      runId: ack.runId,
      userMessageId: ack.userMessageId,
      baselineRunId: null,
      baselineSet: true,
      notifyOnAttention: input.notifyOnAttention ?? false,
      wakeTarget: input.wakeTarget,
    });
    return toMutationAck({ ...ack, watched: armed.watched, warnings: armed.warnings });
  }

  async interruptThread(input: { operationId: string; environmentId?: string; threadId: string; runId?: string }): Promise<MutationAck> {
    const environmentId = this.env(input.environmentId);
    await this.ports.prepare?.(environmentId);
    return this.ports.mutations.interruptRun({
      operationId: input.operationId,
      environmentId,
      threadId: input.threadId,
      ...(input.runId ? { runId: input.runId } : {}),
    });
  }

  async setThreadModel(input: { operationId: string; environmentId?: string; threadId: string; modelSelection: ModelInput }): Promise<MutationAck> {
    const environmentId = this.env(input.environmentId);
    await this.ports.prepare?.(environmentId);
    return this.ports.mutations.setThreadModel({ ...input, environmentId, modelSelection: input.modelSelection });
  }

  async setThreadRuntime(input: { operationId: string; environmentId?: string; threadId: string; runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access" }): Promise<MutationAck> {
    const environmentId = this.env(input.environmentId);
    await this.ports.prepare?.(environmentId);
    return this.ports.mutations.setThreadRuntime({ ...input, environmentId });
  }

  async renameThread(input: { operationId: string; environmentId?: string; threadId: string; title: string }): Promise<MutationAck> {
    const environmentId = this.env(input.environmentId);
    await this.ports.prepare?.(environmentId);
    return this.ports.mutations.renameThread({ ...input, environmentId });
  }

  async watchThread(input: { environmentId?: string; threadId: string; projectId?: string | null; title?: string | null; runId?: string | null; notifyOnAttention?: boolean; wakeTarget?: string }): Promise<{ watchId: string; wakeTarget: string }> {
    const resolved = await this.ports.store.resolveWakeTarget(input.wakeTarget);
    if (!("name" in resolved)) throw new BridgeError(resolved.code, resolved.warning);
    const environmentId = this.env(input.environmentId);
    const bounded = await this.ports.bounded(environmentId, input.threadId);
    if (!bounded.thread) throw new BridgeError("thread_not_found", "This thread was not in the snapshot.");
    if (bounded.thread.threadId !== input.threadId) throw new BridgeError("identity_mismatch", "The response names another thread.");
    const explicitRunId = input.runId ?? null;
    const target = explicitRunId
      ? { runId: explicitRunId, baselineRunId: null, baselineSet: true as const }
      : bareWatchTarget(bounded);
    const watch = await this.ports.watcher.armWatch({
      environmentId,
      projectId: input.projectId ?? bounded.thread.projectId,
      threadId: input.threadId,
      title: input.title ?? bounded.thread.title,
      runId: target.runId,
      userMessageId: null,
      baselineRunId: target.baselineRunId,
      baselineSet: target.baselineSet,
      notifyOnAttention: input.notifyOnAttention ?? false,
      wakeTarget: resolved.name,
    });
    return { watchId: watch.watchId, wakeTarget: resolved.name };
  }

  async unwatchThread(input: { threadId?: string; watchId?: string }): Promise<{ removed: boolean }> {
    if (!input.threadId && !input.watchId) throw new BridgeError("invalid_input", "Pass a threadId or a watchId.");
    if (input.watchId) return { removed: await this.ports.watcher.unwatchOne(input.watchId, input.threadId) };
    return { removed: await this.ports.watcher.unwatchThread(input.threadId!) };
  }

  async listWatches(): Promise<WatchListResult> {
    const watches = await this.ports.store.listWatches();
    const deliveries = await this.ports.store.listDeliveries();
    const names = new Set(await this.ports.store.listWebhookNames());
    const warnings: string[] = [];
    if (names.size === 0) {
      warnings.push("No webhook is configured. Events stay in the local delivery queue until one is saved.");
    } else {
      const missing = [...new Set(watches.map(watch => watch.wakeTarget).filter(name => !names.has(name)))].sort();
      for (const name of missing) {
        warnings.push(`No webhook named "${name}" is registered. Events for that watch stay in the local delivery queue.`);
      }
    }
    return {
      bridgeVersion: "0.1.0",
      watches: watches.map(watch => ({
        watchId: watch.watchId,
        environmentId: watch.environmentId,
        projectId: watch.projectId,
        threadId: watch.threadId,
        title: watch.title,
        runId: watch.runId,
        userMessageId: watch.userMessageId,
        notifyOnAttention: watch.notifyOnAttention,
        armedAt: watch.armedAt,
        expiresAt: watch.expiresAt ?? null,
        state: watchState(watch),
        lastCheckedAt: watch.lastCheckedAt ?? null,
        lastError: watch.lastError ?? null,
        wakeTarget: watch.wakeTarget,
      })),
      pendingDeliveries: deliveries.length,
      warnings,
    };
  }

  async tickWatches(): Promise<void> {
    await this.ports.watcher.tickWatches(async watch => {
      try {
        const bounded = await this.ports.bounded(watch.environmentId, watch.threadId);
        if (!watch.userMessageId && !watch.runId && !watch.baselineSet) {
          const target = bareWatchTarget(bounded);
          if (target.runId) {
            await this.ports.store.adoptWatchRun(watch.watchId, target.runId);
            return selectWatchedRun({
              ...watch,
              runId: target.runId,
              baselineSet: true,
              allowTerminalRunFallback: Boolean(watch.lastCheckedAt),
            }, bounded);
          }
          await this.ports.store.setWatchBaseline(watch.watchId, target.baselineRunId);
          return { runId: null, status: "pending", threadId: watch.threadId };
        }
        return selectWatchedRun({ ...watch, allowTerminalRunFallback: Boolean(watch.lastCheckedAt) }, bounded);
      } catch {
        return { runId: null, status: "unknown", threadId: watch.threadId, error: "read_failed" };
      }
    });
  }

  async waitThread(input: {
    environmentId?: string;
    threadId: string;
    runId?: string | null;
    userMessageId?: string | null;
    operationId?: string;
    timeoutSec?: number;
  }): Promise<{
    bridgeVersion: typeof BRIDGE_VERSION;
    threadId: string;
    runId: string | null;
    status: string;
    timedOut: boolean;
    planReady: boolean;
  }> {
    const environmentId = this.env(input.environmentId);
    const timeoutSec = Math.min(50, Math.max(0, input.timeoutSec ?? 20));
    const deadline = Date.now() + timeoutSec * 1000;
    const sleep = this.ports.sleep ?? delay;
    const explicitRunId = input.runId || null;
    let userMessageId = input.userMessageId || null;
    if (!userMessageId && input.operationId) {
      const payload = await this.ports.store.getOperation(input.operationId);
      if (!payload) throw new BridgeError("operation_not_found", "No saved operation matches that operationId.");
      const journalThread = threadIdFromJournal(payload);
      if (journalThread && journalThread !== input.threadId) {
        throw new BridgeError("invalid_input", "That operation belongs to another thread.");
      }
      userMessageId = messageIdFromJournal(payload);
      if (!userMessageId) throw new BridgeError("invalid_input", "That operation does not record a user message id.");
    }
    const anchored = Boolean(userMessageId || explicitRunId);
    let seen = false;
    let adoptedRunId: string | null = null;
    let baselineRunId: string | null = null;
    let baselineReady = false;
    while (true) {
      const bounded = await this.ports.bounded(environmentId, input.threadId);
      if (!bounded.thread) throw new BridgeError("thread_not_found", "This thread was not in the snapshot.");
      if (bounded.thread.threadId !== input.threadId) throw new BridgeError("identity_mismatch", "The response names another thread.");
      if (!anchored && !baselineReady) {
        const target = bareWatchTarget(bounded);
        adoptedRunId = target.runId;
        baselineRunId = target.baselineRunId;
        baselineReady = true;
      }
      const snapshot = selectWatchedRun({
        threadId: input.threadId,
        title: bounded.thread.title,
        projectId: bounded.thread.projectId,
        runId: anchored ? explicitRunId : adoptedRunId,
        userMessageId,
        baselineRunId: anchored ? null : baselineRunId,
        baselineSet: true,
        allowTerminalRunFallback: seen,
      }, bounded);
      seen = true;
      const settled = isTerminal(snapshot.status) || isAttention(snapshot.status);
      if (settled || Date.now() >= deadline) {
        return {
          bridgeVersion: BRIDGE_VERSION,
          threadId: input.threadId,
          runId: snapshot.runId,
          status: snapshot.status,
          timedOut: !settled,
          planReady: snapshot.planReady === true,
        };
      }
      await sleep(Math.max(0, Math.min(1_000, deadline - Date.now())));
    }
  }

  async bridgeStatus(): Promise<{
    bridgeVersion: typeof BRIDGE_VERSION;
    version: string;
    signedIn: boolean;
    environmentId: string;
    credentialExpiresAt: string | null;
    environmentReachable: "unchecked" | "online" | "offline" | "unavailable";
    webhookConfigured: boolean;
    webhookNames: string[];
    pendingDeliveries: number;
    parkedDeliveries: number;
    watchCount: number;
    watcher: { leaderPid: number | null; leaderIsSelf: boolean; lastTickAt: string | null };
  }> {
    const environmentId = this.ports.defaultEnvironmentId;
    const [session, watches, deliveries, webhookNames, runtime, watcher] = await Promise.all([
      this.ports.store.readSession(),
      this.ports.store.listWatches(),
      this.ports.store.listDeliveries(),
      this.ports.store.listWebhookNames(),
      this.ports.store.readRuntime(),
      this.ports.store.readWatcherLock(),
    ]);
    let environmentReachable: "unchecked" | "online" | "offline" | "unavailable" = "unchecked";
    try {
      environmentReachable = await this.ports.probe(environmentId);
    } catch {
      environmentReachable = "unavailable";
    }
    return {
      bridgeVersion: BRIDGE_VERSION,
      version: VERSION,
      signedIn: Boolean(session?.sessionId),
      environmentId,
      credentialExpiresAt: this.ports.credentialExpiry?.(environmentId) ?? null,
      environmentReachable,
      webhookConfigured: webhookNames.length > 0,
      webhookNames,
      pendingDeliveries: deliveries.length,
      parkedDeliveries: deliveries.filter(entry => entry.parked).length,
      watchCount: watches.length,
      watcher: {
        leaderPid: watcher.pid,
        leaderIsSelf: watcher.pid === process.pid,
        lastTickAt: runtime.lastTickAt,
      },
    };
  }

  async listDeliveries(): Promise<{
    bridgeVersion: typeof BRIDGE_VERSION;
    deliveries: Array<{
      id: string;
      event: string;
      threadId: string | null;
      runId: string | null;
      status: string | null;
      attempts: number;
      lastError: string;
      parked: boolean;
      nextAttemptAt: string | null;
      queuedAt: string | null;
      wakeTarget: string | null;
    }>;
  }> {
    const entries = await this.ports.store.listDeliveries();
    return {
      bridgeVersion: BRIDGE_VERSION,
      deliveries: entries.map(entry => {
        const event = entry.event && typeof entry.event === "object" ? entry.event as Record<string, unknown> : {};
        return {
          id: entry.id,
          event: typeof event.event === "string" ? event.event : "unknown",
          threadId: typeof event.threadId === "string" ? event.threadId : null,
          runId: typeof event.runId === "string" ? event.runId : null,
          status: typeof event.status === "string" ? event.status : null,
          attempts: entry.attempts,
          lastError: entry.lastError,
          parked: entry.parked === true,
          nextAttemptAt: entry.nextAttemptAt ?? null,
          queuedAt: entry.queuedAt ?? null,
          wakeTarget: typeof event.wakeTarget === "string" ? event.wakeTarget : null,
        };
      }),
    };
  }

  async replayDeliveries(): Promise<{ replayed: number; remaining: number }> {
    const replayed = await this.ports.watcher.replayQueued(true);
    const remaining = (await this.ports.store.listDeliveries()).length;
    return { replayed, remaining };
  }

  async purgeDeliveries(id?: string): Promise<{ removed: number }> {
    return { removed: await this.ports.store.purgeDeliveries(id) };
  }

  async captureSnapshot(threadId: string, options?: { redactText?: boolean }): Promise<unknown> {
    const environmentId = this.env();
    const shell = this.ports.shellDocument
      ? await this.ports.shellDocument(environmentId)
      : { raw: null, view: await this.ports.shell(environmentId) };
    const bounded = this.ports.boundedDocument
      ? await this.ports.boundedDocument(environmentId, threadId)
      : { raw: null, view: await this.ports.bounded(environmentId, threadId) };
    const cursor = historyCursorOf(bounded.raw, bounded.view.historyCursor);
    const history = cursor
      ? this.ports.historyDocument
        ? await this.ports.historyDocument(environmentId, threadId, cursor)
        : { raw: null, view: await this.ports.history(environmentId, threadId, cursor) }
      : null;
    return redactFixture({ shell, bounded, history }, { redactText: options?.redactText === true });
  }

  async registerWebhook(input: { name?: string; url: string; secret: string }): Promise<{ saved: true; name: string }> {
    const name = parseWebhookName(input.name?.trim() || DEFAULT_WEBHOOK_NAME);
    const url = webhookUrl(input.url);
    if (input.secret.length < 8 || input.secret.length > 500) {
      throw new BridgeError("invalid_input", "Webhook secret must be 8 to 500 characters.");
    }
    await this.ports.store.saveWebhook({ url, secret: input.secret }, name);
    return { saved: true, name };
  }

  async listWebhooks(): Promise<{ webhooks: Array<{ name: string; url: string }> }> {
    return { webhooks: await this.ports.store.listWebhooks() };
  }

  async deleteWebhook(input: { name: string }): Promise<{ deleted: boolean; name: string }> {
    const name = parseWebhookName(input.name);
    return { deleted: await this.ports.store.deleteWebhook(name), name };
  }

  private async maybeWatch(watch: boolean | undefined, input: {
    environmentId: string;
    projectId: string | null;
    threadId: string;
    title: string | null;
    runId: string | null;
    userMessageId: string | null;
    baselineRunId: string | null;
    baselineSet: boolean;
    notifyOnAttention: boolean;
    wakeTarget?: string;
  }): Promise<{ watched: boolean; warnings?: string[] }> {
    if (watch === false) return { watched: false };
    const resolved = await this.ports.store.resolveWakeTarget(input.wakeTarget);
    if (!("name" in resolved)) return { watched: false, warnings: [resolved.warning] };
    try {
      await this.ports.watcher.armWatch({ ...input, wakeTarget: resolved.name });
      return { watched: true };
    } catch {
      return { watched: false };
    }
  }
}

export async function callWithAuthRetry<T>(run: () => Promise<T>, onAuth: () => void): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof BridgeError) || error.code !== "auth_required") throw error;
    onAuth();
    return run();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function threadIdFromJournal(payload: unknown): string | null {
  const command = commandFromJournal(payload);
  if (!command) return null;
  return typeof command.threadId === "string" && command.threadId.length > 0 ? command.threadId : null;
}

function commandFromJournal(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const command = (payload as { command?: unknown }).command;
  if (!command || typeof command !== "object" || Array.isArray(command)) return null;
  return command as Record<string, unknown>;
}

function messageIdFromJournal(payload: unknown): string | null {
  const record = commandFromJournal(payload);
  if (!record) return null;
  const initial = record.initialMessage;
  if (initial && typeof initial === "object" && !Array.isArray(initial)) {
    const messageId = (initial as { messageId?: unknown }).messageId;
    if (typeof messageId === "string" && messageId.length > 0) return messageId;
  }
  return typeof record.messageId === "string" && record.messageId.length > 0 ? record.messageId : null;
}

function historyCursorOf(raw: unknown, fallback: string | null): string | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (typeof record.historyCursor === "string" && record.historyCursor.length > 0) return record.historyCursor;
    if (typeof record.nextCursor === "string" && record.nextCursor.length > 0) return record.nextCursor;
  }
  return fallback;
}

export async function openBridge(config: Config = readConfig(), store?: Store, http = new Http()): Promise<Bridge> {
  const state = store ?? await Store.load(config.stateDir);
  const auth = new ClerkAuth(config, http, state);
  const connect = new Connect(config, http, auth, state);
  const envFor = async (environmentId: string): Promise<RelayEnv & { wsUrl: string }> => {
    const credential = await connect.acquireEnvironmentCredential(environmentId);
    return { origin: credential.origin, accessToken: credential.accessToken, wsUrl: credential.wsUrl, signer: credential.signer, http };
  };
  const withCredential = <T>(environmentId: string, run: (env: RelayEnv & { wsUrl: string }) => Promise<T>): Promise<T> =>
    callWithAuthRetry(async () => run(await envFor(environmentId)), () => connect.dropCredential(environmentId));
  const activeRun = async (environmentId: string, threadId: string): Promise<ActiveRun | null> => {
    const bounded = await withCredential(environmentId, env => fetchBounded(env, threadId));
    const run = [...bounded.runs].filter(candidate => isInterruptibleRun(candidate.status)).sort((left, right) => (right.ordinal ?? 0) - (left.ordinal ?? 0))[0];
    return run ? { id: run.id, status: run.status } : null;
  };
  return new Bridge({
    defaultEnvironmentId: config.defaultEnvironmentId,
    prepare: async environmentId => {
      await withCredential(environmentId, async () => undefined);
    },
    listLinked: () => connect.listEnvironments(),
    probe: async environmentId => {
      try {
        return await connect.availability(environmentId);
      } catch {
        return "unavailable";
      }
    },
    credentialExpiry: environmentId => connect.cachedExpiry(environmentId),
    shell: async environmentId => withCredential(environmentId, env => fetchShell(env)),
    bounded: async (environmentId, threadId) => withCredential(environmentId, env => fetchBounded(env, threadId)),
    history: async (environmentId, threadId, cursor) => withCredential(environmentId, env => fetchHistory(env, threadId, cursor)),
    shellDocument: async environmentId => withCredential(environmentId, env => fetchShellDocument(env)),
    boundedDocument: async (environmentId, threadId) => withCredential(environmentId, env => fetchBoundedDocument(env, threadId)),
    historyDocument: async (environmentId, threadId, cursor) => withCredential(environmentId, env => fetchHistoryDocument(env, threadId, cursor)),
    mutations: new Mutations(state, (environmentId, method, payload) => withCredential(environmentId, env => environmentRpc(env, method, payload)), activeRun),
    watcher: new Watcher(state),
    store: state,
  });
}
