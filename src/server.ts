import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BRIDGE_VERSION, type EnvironmentListResult, type MutationAck, type ProjectListResult, type ThreadDetailResult, type ThreadListResult } from "./contracts.js";
import { BridgeError, errorResult } from "./errors.js";
import { VERSION } from "./version.js";
import { webhookNameSchema } from "./webhook.js";

const id = z.string().min(1).max(2000);
const operationId = z.string().min(1).max(200);
const offset = z.number().int().min(0).max(1_000_000).optional();
const limit = z.number().int().min(1).max(100).optional();
const runtimeMode = z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const modelSelection = z.object({
  instanceId: z.string().min(1),
  model: z.string().min(1),
});
const bridgeVersion = z.literal(BRIDGE_VERSION);

const environmentListOutput = {
  bridgeVersion,
  environments: z.array(z.object({
    environmentId: id,
    label: z.string(),
    endpoint: z.string(),
    availability: z.enum(["unchecked", "online", "offline", "unavailable"]),
  })),
  total: z.number(),
  nextOffset: z.number().nullable(),
  warnings: z.array(z.string()),
};

const projectListOutput = {
  bridgeVersion,
  environmentId: id,
  projects: z.array(z.object({
    projectId: id,
    title: z.string(),
    workspaceRoot: z.string(),
    defaultModel: modelSelection.nullable(),
  })),
  total: z.number(),
  nextOffset: z.number().nullable(),
  warnings: z.array(z.string()),
};

const threadListItem = z.object({
  threadId: id,
  projectId: id,
  title: z.string(),
  status: z.string(),
  runtimeMode: z.string().nullable(),
  updatedAt: z.string().nullable(),
  activeRunId: z.string().nullable(),
  latestRunId: z.string().nullable(),
});

const threadListOutput = {
  bridgeVersion,
  environmentId: id,
  threads: z.array(threadListItem),
  total: z.number(),
  nextOffset: z.number().nullable(),
  warnings: z.array(z.string()),
};

const threadDetailOutput = {
  bridgeVersion,
  environmentId: id,
  threadId: id,
  projectId: id,
  title: z.string(),
  status: z.string(),
  runtimeMode: z.string().nullable(),
  interactionMode: z.string().nullable(),
  activeRunId: z.string().nullable(),
  latestRunId: z.string().nullable(),
  messages: z.array(z.object({
    id: id,
    role: z.enum(["user", "assistant", "system"]),
    text: z.string(),
  })),
  historyCursor: z.string().nullable(),
  hasMoreHistory: z.boolean(),
  warnings: z.array(z.string()),
  lastError: z.string().nullable(),
  planReady: z.boolean(),
  pendingRequest: z.object({ id: id, kind: z.string() }).nullable(),
  run: z.object({ id: id, status: z.string(), error: z.string().nullable() }).nullable(),
};

const mutationOutput = {
  bridgeVersion,
  kind: z.enum(["start_thread", "send_message", "interrupt_thread", "set_thread_model", "set_thread_runtime", "rename_thread"]),
  operationId: z.string(),
  environmentId: id,
  threadId: id,
  runId: z.string().nullable(),
  userMessageId: z.string().nullable(),
  accepted: z.boolean(),
  watched: z.boolean(),
  warnings: z.array(z.string()).optional(),
};

const watchOutput = { watchId: z.string(), wakeTarget: z.string() };
const unwatchOutput = { removed: z.boolean() };
const watchListOutput = {
  bridgeVersion,
  watches: z.array(z.object({
    watchId: z.string(),
    environmentId: id,
    projectId: z.string().nullable(),
    threadId: id,
    title: z.string().nullable(),
    runId: z.string().nullable(),
    userMessageId: z.string().nullable(),
    notifyOnAttention: z.boolean(),
    armedAt: z.string(),
    expiresAt: z.string().nullable(),
    state: z.enum(["pending", "running", "attention", "fired", "expired"]),
    lastCheckedAt: z.string().nullable(),
    lastError: z.string().nullable(),
    wakeTarget: z.string(),
  })),
  pendingDeliveries: z.number(),
  warnings: z.array(z.string()),
};

export const TOOL_NAMES = [
  "list_environments",
  "list_projects",
  "list_threads",
  "get_thread",
  "start_thread",
  "send_message",
  "interrupt_thread",
  "set_thread_model",
  "set_thread_runtime",
  "rename_thread",
  "watch_thread",
  "unwatch_thread",
  "list_watches",
  "bridge_status",
  "register_webhook",
  "list_webhooks",
  "delete_webhook",
  "wait_thread",
  "list_deliveries",
  "replay_deliveries",
] as const;

export interface WatchListResult {
  bridgeVersion: "0.1.0";
  watches: Array<{
    watchId: string;
    environmentId: string;
    projectId: string | null;
    threadId: string;
    title: string | null;
    runId: string | null;
    userMessageId: string | null;
    notifyOnAttention: boolean;
    armedAt: string;
    expiresAt: string | null;
    state: "pending" | "running" | "attention" | "fired" | "expired";
    lastCheckedAt: string | null;
    lastError: string | null;
    wakeTarget: string;
  }>;
  pendingDeliveries: number;
  warnings: string[];
}

/** Methods the stdio server calls. Tests pass a stub with this shape. */
export interface ToolBridge {
  listEnvironments(input: { offset?: number; limit?: number; checkAvailability?: boolean }): Promise<EnvironmentListResult>;
  listProjects(input: { environmentId?: string; offset?: number; limit?: number }): Promise<ProjectListResult>;
  listThreads(input: { environmentId?: string; projectId?: string; status?: string; offset?: number; limit?: number }): Promise<ThreadListResult>;
  getThread(input: { environmentId?: string; threadId: string; beforeCursor?: string; limit?: number; sinceMessageId?: string }): Promise<ThreadDetailResult>;
  startThread(input: {
    operationId: string;
    environmentId?: string;
    projectId: string;
    title: string;
    instructions: string;
    modelSelection?: { instanceId: string; model: string };
    runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
    interactionMode?: "default" | "plan";
    watch?: boolean;
    notifyOnAttention?: boolean;
    wakeTarget?: string;
  }): Promise<MutationAck>;
  sendMessage(input: {
    operationId: string;
    environmentId?: string;
    threadId: string;
    instructions: string;
    mode?: "auto" | "queue" | "steer" | "restart";
    watch?: boolean;
    notifyOnAttention?: boolean;
    wakeTarget?: string;
  }): Promise<MutationAck>;
  interruptThread(input: { operationId: string; environmentId?: string; threadId: string; runId?: string }): Promise<MutationAck>;
  setThreadModel(input: { operationId: string; environmentId?: string; threadId: string; modelSelection: { instanceId: string; model: string } }): Promise<MutationAck>;
  setThreadRuntime(input: { operationId: string; environmentId?: string; threadId: string; runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access" }): Promise<MutationAck>;
  renameThread(input: { operationId: string; environmentId?: string; threadId: string; title: string }): Promise<MutationAck>;
  watchThread(input: { environmentId?: string; threadId: string; projectId?: string | null; title?: string | null; runId?: string | null; notifyOnAttention?: boolean; wakeTarget?: string }): Promise<{ watchId: string; wakeTarget: string }>;
  unwatchThread(input: { threadId?: string; watchId?: string }): Promise<{ removed: boolean }>;
  listWatches(): Promise<WatchListResult>;
  tickWatches(): Promise<void>;
  bridgeStatus(): Promise<{
    bridgeVersion: "0.1.0";
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
  }>;
  waitThread(input: {
    environmentId?: string;
    threadId: string;
    runId?: string | null;
    userMessageId?: string | null;
    operationId?: string;
    timeoutSec?: number;
  }): Promise<{
    bridgeVersion: "0.1.0";
    threadId: string;
    runId: string | null;
    status: string;
    timedOut: boolean;
    planReady: boolean;
  }>;
  listDeliveries(): Promise<{
    bridgeVersion: "0.1.0";
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
  }>;
  replayDeliveries(): Promise<{ replayed: number; remaining: number }>;
  registerWebhook(input: { name?: string; url: string; secret: string }): Promise<{ saved: true; name: string }>;
  listWebhooks(): Promise<{ webhooks: Array<{ name: string; url: string }> }>;
  deleteWebhook(input: { name: string }): Promise<{ deleted: boolean; name: string }>;
}

function ok(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function fail(error: unknown) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(errorResult(error)) }],
  };
}

function guard<T extends object>(run: () => Promise<T>) {
  return run().then(ok, error => fail(error));
}

export function createServer(bridge: ToolBridge): McpServer {
  const server = new McpServer({ name: "t3bridge", version: VERSION });

  server.registerTool("list_environments", {
    description: "List T3 environments linked to the signed-in account. Omit checkAvailability to skip the probe. The default machine is menet2.",
    inputSchema: { offset, limit, checkAvailability: z.boolean().optional() },
    outputSchema: environmentListOutput,
    annotations: { readOnlyHint: true },
  }, async input => guard(() => bridge.listEnvironments(input)));

  server.registerTool("list_projects", {
    description: "List projects on one environment, including each project's default model. environmentId defaults to menet2.",
    inputSchema: { environmentId: id.optional(), offset, limit },
    outputSchema: projectListOutput,
    annotations: { readOnlyHint: true },
  }, async input => guard(() => bridge.listProjects(input)));

  server.registerTool("list_threads", {
    description: "List unarchived threads. Filter by projectId or bridge status and page with offset and limit.",
    inputSchema: { environmentId: id.optional(), projectId: id.optional(), status: z.string().min(1).max(80).optional(), offset, limit },
    outputSchema: threadListOutput,
    annotations: { readOnlyHint: true },
  }, async input => guard(() => bridge.listThreads(input)));

  server.registerTool("get_thread", {
    description: "Read one thread's status and recent messages. Pass beforeCursor from a previous page. limit defaults to 20 and caps at 100. sinceMessageId drops messages up to that id from this page.",
    inputSchema: { environmentId: id.optional(), threadId: id, beforeCursor: z.string().min(1).max(8000).optional(), sinceMessageId: id.optional(), limit },
    outputSchema: threadDetailOutput,
    annotations: { readOnlyHint: true },
  }, async input => guard(() => bridge.getThread(input)));

  server.registerTool("start_thread", {
    description: "Create a thread in the project root and send the first instructions. runtimeMode defaults to approval-required. full-access is used only when you pass it. A webhook watch is armed unless watch is false. Pass wakeTarget when more than one webhook is registered. Worktree projects are rejected. Pass a new operationId and reuse it to retry.",
    inputSchema: {
      operationId,
      environmentId: id.optional(),
      projectId: id,
      title: z.string().min(1).max(500),
      instructions: z.string().min(1).max(100_000),
      modelSelection: modelSelection.optional(),
      runtimeMode: runtimeMode.optional(),
      interactionMode: z.enum(["default", "plan"]).optional(),
      watch: z.boolean().optional(),
      notifyOnAttention: z.boolean().optional(),
      wakeTarget: webhookNameSchema.optional(),
    },
    outputSchema: mutationOutput,
  }, async input => guard(() => bridge.startThread(input)));

  server.registerTool("send_message", {
    description: "Send a follow-up. mode is auto, queue, steer, or restart. The ack includes userMessageId. restart does not pin the interrupted run. A webhook watch is armed unless watch is false. Pass wakeTarget when more than one webhook is registered. Reuse operationId to retry the same send.",
    inputSchema: {
      operationId,
      environmentId: id.optional(),
      threadId: id,
      instructions: z.string().min(1).max(100_000),
      mode: z.enum(["auto", "queue", "steer", "restart"]).optional(),
      watch: z.boolean().optional(),
      notifyOnAttention: z.boolean().optional(),
      wakeTarget: webhookNameSchema.optional(),
    },
    outputSchema: mutationOutput,
  }, async input => guard(() => bridge.sendMessage(input)));

  server.registerTool("interrupt_thread", {
    description: "Interrupt the active run. This does not approve a pending permission.",
    inputSchema: { operationId, environmentId: id.optional(), threadId: id, runId: id.optional() },
    outputSchema: mutationOutput,
  }, async input => guard(() => bridge.interruptThread(input)));

  server.registerTool("set_thread_model", {
    description: "Change the model selection on an existing thread.",
    inputSchema: { operationId, environmentId: id.optional(), threadId: id, modelSelection },
    outputSchema: mutationOutput,
  }, async input => guard(() => bridge.setThreadModel(input)));

  server.registerTool("set_thread_runtime", {
    description: "Change runtimeMode. full-access is applied only when you pass it.",
    inputSchema: { operationId, environmentId: id.optional(), threadId: id, runtimeMode },
    outputSchema: mutationOutput,
  }, async input => guard(() => bridge.setThreadRuntime(input)));

  server.registerTool("rename_thread", {
    description: "Rename a thread.",
    inputSchema: { operationId, environmentId: id.optional(), threadId: id, title: z.string().min(1).max(500) },
    outputSchema: mutationOutput,
  }, async input => guard(() => bridge.renameThread(input)));

  server.registerTool("watch_thread", {
    description: "Arm a webhook for the active run, or the next run if the thread is idle. Terminal statuses notify once per runId. Watches expire after 24 hours. Set notifyOnAttention to also report awaiting_approval, awaiting_input, and plan_ready. Pass wakeTarget when more than one webhook is registered.",
    inputSchema: {
      environmentId: id.optional(),
      threadId: id,
      projectId: id.nullable().optional(),
      title: z.string().max(500).nullable().optional(),
      runId: id.nullable().optional(),
      notifyOnAttention: z.boolean().optional(),
      wakeTarget: webhookNameSchema.optional(),
    },
    outputSchema: watchOutput,
  }, async input => guard(() => bridge.watchThread(input)));

  server.registerTool("unwatch_thread", {
    description: "Remove every watch on a thread, or one watch when watchId is set.",
    inputSchema: { threadId: id.optional(), watchId: z.string().min(1).max(200).optional() },
    outputSchema: unwatchOutput,
  }, async input => {
    if (!input.threadId && !input.watchId) return fail(new BridgeError("invalid_input", "Pass a threadId or a watchId."));
    return guard(() => bridge.unwatchThread(input));
  });

  server.registerTool("list_watches", {
    description: "List armed watches, their state, and how many webhook deliveries are waiting in the local queue.",
    inputSchema: {},
    outputSchema: watchListOutput,
    annotations: { readOnlyHint: true },
  }, async () => guard(() => bridge.listWatches()));

  server.registerTool("bridge_status", {
    description: "Report sign-in, environment reachability, watcher leadership, registered webhook names, and queued deliveries. No secrets. webhookConfigured is true when at least one webhook is registered.",
    inputSchema: {},
    outputSchema: {
      bridgeVersion,
      version: z.string(),
      signedIn: z.boolean(),
      environmentId: id,
      credentialExpiresAt: z.string().nullable(),
      environmentReachable: z.enum(["unchecked", "online", "offline", "unavailable"]),
      webhookConfigured: z.boolean(),
      webhookNames: z.array(z.string()),
      pendingDeliveries: z.number(),
      parkedDeliveries: z.number(),
      watchCount: z.number(),
      watcher: z.object({
        leaderPid: z.number().nullable(),
        leaderIsSelf: z.boolean(),
        lastTickAt: z.string().nullable(),
      }),
    },
    annotations: { readOnlyHint: true },
  }, async () => guard(() => bridge.bridgeStatus()));

  server.registerTool("wait_thread", {
    description: "Wait until the watched run is terminal or needs attention. Pass userMessageId or operationId from the send ack. Without an id, an idle thread waits for a newer run and does not return the previous finished run. timeoutSec defaults to 20 and cannot exceed 50. This does not approve permissions.",
    inputSchema: {
      environmentId: id.optional(),
      threadId: id,
      runId: id.nullish(),
      userMessageId: id.nullish(),
      operationId: operationId.optional(),
      timeoutSec: z.number().int().min(0).max(50).optional(),
    },
    outputSchema: {
      bridgeVersion,
      threadId: id,
      runId: z.string().nullable(),
      status: z.string(),
      timedOut: z.boolean(),
      planReady: z.boolean(),
    },
  }, async input => guard(() => bridge.waitThread(input)));

  server.registerTool("list_deliveries", {
    description: "List queued webhook deliveries. The webhook secret is not included.",
    inputSchema: {},
    outputSchema: {
      bridgeVersion,
      deliveries: z.array(z.object({
        id: z.string(),
        event: z.string(),
        threadId: z.string().nullable(),
        runId: z.string().nullable(),
        status: z.string().nullable(),
        attempts: z.number(),
        lastError: z.string(),
        parked: z.boolean(),
        nextAttemptAt: z.string().nullable(),
        queuedAt: z.string().nullable(),
        wakeTarget: z.string().nullable(),
      })),
    },
    annotations: { readOnlyHint: true },
  }, async () => guard(() => bridge.listDeliveries()));

  server.registerTool("replay_deliveries", {
    description: "Unpark queued webhook deliveries and try them once.",
    inputSchema: {},
    outputSchema: { replayed: z.number(), remaining: z.number() },
  }, async () => guard(() => bridge.replayDeliveries()));

  server.registerTool("register_webhook", {
    description: "Save a named routine webhook. Omit name to update default. The secret is stored and is not returned.",
    inputSchema: {
      name: webhookNameSchema.optional(),
      url: z.string().url(),
      secret: z.string().min(8).max(500),
    },
    outputSchema: { saved: z.literal(true), name: webhookNameSchema },
  }, async input => guard(() => bridge.registerWebhook(input)));

  server.registerTool("list_webhooks", {
    description: "List registered webhook names and URLs. Secrets are not included.",
    inputSchema: {},
    outputSchema: { webhooks: z.array(z.object({ name: webhookNameSchema, url: z.string() })) },
    annotations: { readOnlyHint: true },
  }, async () => guard(() => bridge.listWebhooks()));

  server.registerTool("delete_webhook", {
    description: "Delete one named webhook. Other names are left in place.",
    inputSchema: { name: webhookNameSchema },
    outputSchema: { deleted: z.boolean(), name: webhookNameSchema },
  }, async input => guard(() => bridge.deleteWebhook(input)));

  return server;
}
