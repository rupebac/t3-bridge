import { createHash, randomUUID } from "node:crypto";
import { BRIDGE_VERSION, SUMMARY_LIMIT, clipText } from "./contracts.js";
import { isAttention, isTerminal } from "./status.js";
import type { Store, WatchRecord } from "./store.js";
import { DEFAULT_WEBHOOK_NAME } from "./webhook.js";

const WATCH_TTL_MS = 24 * 60 * 60 * 1000;
const REPLAY_LIMIT = 5;
const REPLAY_BUDGET_MS = 15_000;
const PARKED_STATUSES = new Set([400, 401, 403, 404, 410]);

export interface RunSnapshot {
  runId: string | null;
  status: string;
  summary?: string | null;
  title?: string | null;
  projectId?: string | null;
  threadId?: string | null;
  planReady?: boolean;
  attentionKind?: string | null;
  error?: string | null;
}

export interface ArmWatchInput {
  environmentId: string;
  projectId: string | null;
  threadId: string;
  title: string | null;
  runId: string | null;
  userMessageId?: string | null;
  baselineRunId?: string | null;
  baselineSet?: boolean;
  notifyOnAttention?: boolean;
  watchId?: string;
  expiresAt?: string | null;
  wakeTarget?: string;
}

type WatchEvent = "t3.run.terminal" | "t3.run.attention" | "t3.watch.expired";
type Poster = (url: string, init?: RequestInit) => Promise<Response>;

/** Stable across retries. Expiry events key on the watch; run events key on event, run, and status. */
export function webhookEventId(event: string, runId: string, status: string, watchId?: string): string {
  const material = event === "t3.watch.expired"
    ? `${event}\n${watchId ?? ""}`
    : `${event}\n${runId}\n${status}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export function watchKey(watch: { threadId: string; userMessageId?: string | null; runId?: string | null }): string {
  if (watch.userMessageId) return `${watch.threadId}\nmsg:${watch.userMessageId}`;
  if (watch.runId) return `${watch.threadId}\nrun:${watch.runId}`;
  return `${watch.threadId}\nbare`;
}

export class Watcher {
  private ticking = false;

  constructor(
    private store: Store,
    private post: Poster = fetch,
    private sleep: (ms: number) => Promise<void> = delay,
    private now: () => number = Date.now,
  ) {}

  async armWatch(input: ArmWatchInput): Promise<WatchRecord> {
    const key = watchKey(input);
    const existing = await this.store.listWatches();
    for (const watch of existing) {
      if (watchKey(watch) === key) await this.store.deleteWatch(watch.watchId);
    }
    const explicit = Boolean(input.runId || input.userMessageId);
    const watch: WatchRecord = {
      watchId: input.watchId ?? randomUUID(),
      environmentId: input.environmentId,
      projectId: input.projectId,
      threadId: input.threadId,
      title: input.title === null ? null : clipText(input.title, 500),
      runId: input.runId,
      userMessageId: input.userMessageId ?? null,
      baselineRunId: input.baselineRunId ?? null,
      baselineSet: input.baselineSet ?? explicit,
      notifyOnAttention: input.notifyOnAttention ?? false,
      wakeTarget: input.wakeTarget || DEFAULT_WEBHOOK_NAME,
      armedAt: new Date(this.now()).toISOString(),
      expiresAt: input.expiresAt ?? new Date(this.now() + WATCH_TTL_MS).toISOString(),
      firedTerminal: [],
      firedAttention: [],
    };
    await this.store.saveWatch(watch);
    return watch;
  }

  async unwatchThread(threadId: string): Promise<boolean> {
    const watches = await this.store.listWatches();
    let removed = false;
    for (const watch of watches) {
      if (watch.threadId !== threadId) continue;
      await this.store.deleteWatch(watch.watchId);
      removed = true;
    }
    return removed;
  }

  async unwatchOne(watchId: string, threadId?: string): Promise<boolean> {
    const watches = await this.store.listWatches();
    const match = watches.find(watch => watch.watchId === watchId);
    if (!match) return false;
    if (threadId && match.threadId !== threadId) return false;
    await this.store.deleteWatch(watchId);
    return true;
  }

  async tickWatches(read: (watch: WatchRecord) => Promise<RunSnapshot>): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.store.noteTick(new Date(this.now()).toISOString());
      const watches = await this.store.listWatches();
      for (const watch of watches) {
        if (this.expired(watch)) {
          await this.deliver(watch, {
            runId: watch.runId,
            status: "expired",
            summary: "",
            threadId: watch.threadId,
            title: watch.title,
            projectId: watch.projectId,
          }, watch.runId ?? "", "t3.watch.expired");
          await this.store.deleteWatch(watch.watchId);
          continue;
        }
        const snapshot = await read(watch);
        await this.store.observeWatch(watch.watchId, {
          lastCheckedAt: new Date(this.now()).toISOString(),
          lastStatus: snapshot.status,
          lastError: snapshot.error ? clipText(snapshot.error, 500) : null,
        });
        if (snapshot.threadId && snapshot.threadId !== watch.threadId) continue;
        const runId = snapshot.runId;
        if (!runId) continue;
        if (watch.runId && watch.runId !== runId && !watch.userMessageId && watch.baselineSet) continue;
        if (isTerminal(snapshot.status)) {
          const key = runId;
          if (await this.store.hasFired(key)) {
            await this.store.markFired(watch.watchId, key, true);
            continue;
          }
          await this.deliver(watch, snapshot, runId, "t3.run.terminal");
          await this.store.markFired(watch.watchId, key, true);
          continue;
        }
        if (watch.notifyOnAttention && isAttention(snapshot.status)) {
          const key = `${runId}:${snapshot.status}`;
          if (await this.store.hasFired(key)) continue;
          await this.deliver(watch, snapshot, runId, "t3.run.attention");
          await this.store.markFired(watch.watchId, key, false);
        }
      }
      await this.replayDeliveries();
    } finally {
      this.ticking = false;
    }
  }

  async replayQueued(force = false): Promise<number> {
    const role = await this.store.watcherRole();
    if (role === "other") {
      if (force) await this.store.releaseDeliveries();
      return 0;
    }
    if (this.ticking) {
      if (force) await this.store.releaseDeliveries();
      return 0;
    }
    this.ticking = true;
    try {
      if (force) await this.store.releaseDeliveries();
      const before = (await this.store.listDeliveries()).length;
      await this.replayDeliveries();
      const after = (await this.store.listDeliveries()).length;
      return Math.max(0, before - after);
    } finally {
      this.ticking = false;
    }
  }

  private expired(watch: WatchRecord): boolean {
    const explicit = watch.expiresAt ? Date.parse(watch.expiresAt) : Number.NaN;
    const at = Number.isFinite(explicit) ? explicit : Date.parse(watch.armedAt) + WATCH_TTL_MS;
    return Number.isFinite(at) && at <= this.now();
  }

  private async replayDeliveries(): Promise<void> {
    const queued = (await this.store.listDeliveries()).slice().sort(byQueuedAt);
    if (queued.length === 0) return;
    const now = this.now();
    const started = Date.now();
    let sent = 0;
    for (const entry of queued) {
      const wakeTarget = wakeTargetOf(entry.event);
      const webhook = await this.store.getWebhook(wakeTarget);
      if (!webhook) {
        if (entry.lastError !== "webhook_not_configured" || entry.parked) {
          await this.store.patchDelivery(entry.id, {
            attempts: entry.attempts,
            lastError: "webhook_not_configured",
            parked: false,
            nextAttemptAt: entry.nextAttemptAt,
          });
        }
        continue;
      }
      const due = entry.parked !== true && (!entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= now);
      if (!due) continue;
      if (sent >= REPLAY_LIMIT || Date.now() - started > REPLAY_BUDGET_MS) break;
      sent += 1;
      const delivered = await this.postEvent(webhook.url, webhook.secret, entry.event);
      if (delivered.ok) {
        await this.store.removeDelivery(entry.id);
        continue;
      }
      const parked = delivered.status !== undefined && PARKED_STATUSES.has(delivered.status);
      const attempts = entry.attempts + 1;
      await this.store.patchDelivery(entry.id, {
        attempts,
        lastError: delivered.error,
        parked,
        nextAttemptAt: parked ? entry.nextAttemptAt : new Date(now + backoffMs(attempts)).toISOString(),
      });
    }
  }

  private async deliver(watch: WatchRecord, snapshot: RunSnapshot, runId: string, event: WatchEvent): Promise<void> {
    const summary = clipText(snapshot.summary ?? "", SUMMARY_LIMIT);
    const eventId = webhookEventId(event, runId, snapshot.status, watch.watchId);
    const body: Record<string, unknown> = {
      event,
      eventId,
      occurredAt: new Date(this.now()).toISOString(),
      bridgeVersion: BRIDGE_VERSION,
      environmentId: watch.environmentId,
      projectId: snapshot.projectId ?? watch.projectId ?? "",
      threadId: watch.threadId,
      title: snapshot.title ?? watch.title ?? "",
      runId,
      status: snapshot.status,
      summary,
    };
    if (snapshot.planReady) body.planReady = true;
    if (event === "t3.run.attention" && snapshot.attentionKind) body.attention = { kind: snapshot.attentionKind };
    if (snapshot.status === "failed" && snapshot.error) body.errorExcerpt = clipText(snapshot.error, SUMMARY_LIMIT);
    if (event === "t3.watch.expired") body.watchId = watch.watchId;
    const wakeTarget = watch.wakeTarget || DEFAULT_WEBHOOK_NAME;
    body.wakeTarget = wakeTarget;
    const webhook = await this.store.getWebhook(wakeTarget);
    if (!webhook) {
      await this.store.enqueueDelivery({ id: randomUUID(), event: body, attempts: 0, lastError: "webhook_not_configured" });
      return;
    }
    const blockedUntil = await this.backoffUntil();
    if (blockedUntil !== null) {
      await this.store.enqueueDelivery({
        id: randomUUID(),
        event: body,
        attempts: 0,
        lastError: "webhook_backing_off",
        nextAttemptAt: new Date(blockedUntil).toISOString(),
      });
      return;
    }
    let lastError = "delivery_failed";
    let parked = false;
    let attempts = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) await this.sleep(200 * 2 ** (attempt - 2));
      attempts = attempt;
      const delivered = await this.postEvent(webhook.url, webhook.secret, body);
      if (delivered.ok) return;
      lastError = delivered.error;
      if (delivered.status !== undefined && PARKED_STATUSES.has(delivered.status)) {
        parked = true;
        break;
      }
    }
    await this.store.enqueueDelivery({
      id: randomUUID(),
      event: body,
      attempts,
      lastError,
      parked,
      nextAttemptAt: parked ? undefined : new Date(this.now() + backoffMs(Math.max(attempts, 3))).toISOString(),
    });
  }

  /** While an unparked transport or 5xx delivery is waiting, new events join the queue. */
  private async backoffUntil(): Promise<number | null> {
    const now = this.now();
    let until: number | null = null;
    for (const entry of await this.store.listDeliveries()) {
      if (entry.parked) continue;
      const at = entry.nextAttemptAt ? Date.parse(entry.nextAttemptAt) : Number.NaN;
      if (!Number.isFinite(at) || at <= now) continue;
      if (entry.lastError !== "transport_error" && !/^http_5\d\d$/.test(entry.lastError)) continue;
      until = until === null ? at : Math.min(until, at);
    }
    return until;
  }

  private async postEvent(url: string, secret: string, body: unknown): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
    const eventId = body && typeof body === "object" && "eventId" in body && typeof body.eventId === "string"
      ? body.eventId
      : randomUUID();
    try {
      const response = await this.post(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "idempotency-key": eventId,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true };
      return { ok: false, error: `http_${response.status}`, status: response.status };
    } catch {
      return { ok: false, error: "transport_error" };
    }
  }
}

function byQueuedAt(left: { queuedAt?: string }, right: { queuedAt?: string }): number {
  return (left.queuedAt ?? "").localeCompare(right.queuedAt ?? "");
}

function wakeTargetOf(event: unknown): string {
  if (event && typeof event === "object" && "wakeTarget" in event) {
    const value = (event as { wakeTarget?: unknown }).wakeTarget;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return DEFAULT_WEBHOOK_NAME;
}

function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 3);
  return Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(exponent, 7));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
