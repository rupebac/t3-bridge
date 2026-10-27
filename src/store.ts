import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BridgeError } from "./errors.js";
import { DEFAULT_WEBHOOK_NAME, parseWebhookName } from "./webhook.js";

export const STATE_VERSION = 1;

const pendingLoginSchema = z.object({
  loginId: z.string().min(1),
  signInId: z.string().min(1),
  expiresAt: z.number(),
  factor: z.enum(["preparing", "email_code", "totp"]),
});

const sessionSchema = z.object({
  binding: z.string(),
  clientJwt: z.string(),
  sessionId: z.string().optional(),
  accountId: z.string().optional(),
  pendingLogin: pendingLoginSchema.optional(),
});

export type SessionState = z.infer<typeof sessionSchema>;

const watchSchema = z.object({
  watchId: z.string().min(1).max(200),
  environmentId: z.string().min(1).max(2000),
  projectId: z.string().min(1).max(2000).nullable(),
  threadId: z.string().min(1).max(2000),
  title: z.string().max(500).nullable(),
  runId: z.string().min(1).max(2000).nullable(),
  userMessageId: z.string().min(1).max(2000).nullable().default(null),
  baselineRunId: z.string().min(1).max(2000).nullable().default(null),
  baselineSet: z.boolean().default(false),
  notifyOnAttention: z.boolean(),
  armedAt: z.string().min(1).max(80),
  expiresAt: z.string().min(1).max(80).nullable().optional(),
  lastCheckedAt: z.string().min(1).max(80).nullable().optional(),
  lastStatus: z.string().max(80).nullable().optional(),
  lastError: z.string().max(500).nullable().optional(),
  wakeTarget: z.string().min(1).max(64).default(DEFAULT_WEBHOOK_NAME),
  firedTerminal: z.array(z.string()).default([]),
  firedAttention: z.array(z.string()).default([]),
});

export type WatchRecord = z.infer<typeof watchSchema>;

const webhookSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(1),
});

export type WebhookConfig = z.infer<typeof webhookSchema>;

const stateSchema = z.object({
  version: z.literal(STATE_VERSION),
  auth: sessionSchema.optional(),
  privateJwk: z.record(z.string(), z.string()).optional(),
  operations: z.record(z.string(), z.object({ payload: z.unknown(), savedAt: z.string().optional() })),
  watches: z.record(z.string(), watchSchema),
  webhooks: z.record(z.string(), webhookSchema).default({}),
  fired: z.record(z.string(), z.string()).default({}),
  runtime: z.object({ lastTickAt: z.string().nullable().optional() }).optional(),
  deliveries: z.array(z.object({
    id: z.string(),
    event: z.unknown(),
    attempts: z.number().int().nonnegative(),
    lastError: z.string(),
    queuedAt: z.string().optional(),
    nextAttemptAt: z.string().optional(),
    parked: z.boolean().optional().default(false),
  })).default([]),
});

export type State = z.infer<typeof stateSchema>;

const DELIVERY_CAP = 50;
const DELIVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FIRED_MAX_AGE_MS = DELIVERY_MAX_AGE_MS;
const JOURNAL_MAX_AGE_MS = DELIVERY_MAX_AGE_MS;
const FRESH_LOCK_MS = 10_000;

const stateFileSchema = stateSchema.extend({
  webhook: webhookSchema.optional(),
  webhooks: z.record(z.string(), webhookSchema).optional(),
});

function normalizeState(parsed: z.infer<typeof stateFileSchema>): State {
  const webhooks = { ...(parsed.webhooks ?? {}) };
  if (parsed.webhook && webhooks[DEFAULT_WEBHOOK_NAME] === undefined) {
    webhooks[DEFAULT_WEBHOOK_NAME] = parsed.webhook;
  }
  return {
    version: parsed.version,
    ...(parsed.auth ? { auth: parsed.auth } : {}),
    ...(parsed.privateJwk ? { privateJwk: parsed.privateJwk } : {}),
    operations: parsed.operations,
    watches: parsed.watches,
    webhooks,
    fired: parsed.fired,
    ...(parsed.runtime ? { runtime: parsed.runtime } : {}),
    deliveries: parsed.deliveries,
  };
}

function emptyState(): State {
  return { version: STATE_VERSION, operations: {}, watches: {}, deliveries: [], fired: {}, webhooks: {} };
}

export interface DeliveryEntry {
  id: string;
  event: unknown;
  attempts: number;
  lastError: string;
  queuedAt?: string;
  nextAttemptAt?: string;
  parked: boolean;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pruneFired(fired: Record<string, string>): Record<string, string> {
  const cutoff = Date.now() - FIRED_MAX_AGE_MS;
  const next: Record<string, string> = {};
  for (const [key, at] of Object.entries(fired)) {
    const time = Date.parse(at);
    if (Number.isFinite(time) && time >= cutoff) next[key] = at;
  }
  return next;
}

function capDeliveries(entries: Array<DeliveryEntry | (Omit<DeliveryEntry, "parked"> & { parked?: boolean })>): DeliveryEntry[] {
  const cutoff = Date.now() - DELIVERY_MAX_AGE_MS;
  const fresh = entries.filter(entry => {
    const time = entry.queuedAt ? Date.parse(entry.queuedAt) : Date.now();
    return Number.isFinite(time) && time >= cutoff;
  });
  return fresh.slice(-DELIVERY_CAP).map(entry => ({ ...entry, parked: entry.parked === true }));
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

async function readStateFile(dir: string): Promise<State> {
  const path = join(dir, "state.json");
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new BridgeError("unsafe_state", "Credential state must be a regular file.");
    }
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const version = z.object({ version: z.number() }).safeParse(parsed);
    if (!version.success) throw new BridgeError("invalid_state", "The bridge state file has an unsupported format.");
    if (version.data.version > STATE_VERSION) {
      throw new BridgeError("state_too_new", "state_too_new: this state file was written by a newer t3-bridge. Refusing to read it.");
    }
    const decoded = stateFileSchema.safeParse(parsed);
    if (!decoded.success) throw new BridgeError("invalid_state", "The bridge state file has an unsupported format.");
    return normalizeState(decoded.data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class Store {
  private tail: Promise<void> = Promise.resolve();

  private constructor(readonly dir: string, private state: State) {}

  static async load(dir: string): Promise<Store> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const directory = await lstat(dir);
    if (directory.isSymbolicLink()) {
      throw new BridgeError("unsafe_state", "The state directory must not be a symbolic link.");
    }
    await chmod(dir, 0o700);
    const store = new Store(dir, await readStateFile(dir));
    await store.persistLegacyWebhookMigration();
    return store;
  }

  private async writeAtomically(state: State): Promise<void> {
    const path = join(this.dir, "state.json");
    const temp = join(this.dir, `.state-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      const handle = await open(temp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temp, 0o600);
      await rename(temp, path);
      await chmod(path, 0o600);
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** Re-read state.json under state.lock so another process cannot be overwritten. */
  private async mutate(apply: (state: State) => void): Promise<void> {
    const lockPath = join(this.dir, "state.lock");
    const started = Date.now();
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
        } finally {
          await handle.close();
        }
        try {
          this.state = await readStateFile(this.dir);
          pruneJournal(this.state);
          apply(this.state);
          await this.writeAtomically(this.state);
        } finally {
          await rm(lockPath, { force: true });
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stolen = await this.stealStaleLock(lockPath);
        if (!stolen) {
          if (Date.now() - started > 5_000) {
            throw new BridgeError("state_busy", "Another t3-bridge process holds the state lock. Stop that process and retry.");
          }
          await delay(50);
        }
      }
    }
  }

  private async stealStaleLock(lockPath: string): Promise<boolean> {
    try {
      const [text, stat] = await Promise.all([readFile(lockPath, "utf8"), lstat(lockPath)]);
      const pid = Number(text.split("\n")[0]);
      if (!Number.isInteger(pid) || pid <= 0) {
        if (Date.now() - stat.mtimeMs < FRESH_LOCK_MS) return false;
        await rm(lockPath, { force: true });
        return true;
      }
      if (pidAlive(pid)) return false;
      await rm(lockPath, { force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
  }

  private async refresh(): Promise<State> {
    this.state = await readStateFile(this.dir);
    return this.state;
  }

  /** Rewrite a legacy `{ webhook }` file as `webhooks.default` once. Later writes stay on the registry. */
  private persistLegacyWebhookMigration(): Promise<void> {
    return this.enqueue(async () => {
      const path = join(this.dir, "state.json");
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (!raw || typeof raw !== "object" || !Object.prototype.hasOwnProperty.call(raw, "webhook")) return;
      await this.mutate(() => undefined);
    });
  }

  /** Only one serve process should poll watches. A live pid keeps the lock. */
  async tryAcquireWatcher(): Promise<boolean> {
    const path = join(this.dir, "watcher.lock");
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const [text, stat] = await Promise.all([readFile(path, "utf8"), lstat(path)]);
        const pid = Number(text.split("\n")[0]);
        if (pid === process.pid) return true;
        if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return false;
        if (!(Number.isInteger(pid) && pid > 0) && Date.now() - stat.mtimeMs < FRESH_LOCK_MS) return false;
        await rm(path, { force: true });
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
      return this.tryAcquireWatcher();
    }
  }

  releaseWatcherSync(): void {
    const path = join(this.dir, "watcher.lock");
    try {
      const pid = Number(readFileSync(path, "utf8").split("\n")[0]);
      if (pid === process.pid) unlinkSync(path);
    } catch {
      // The lock is already gone.
    }
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  saveSession(session: SessionState): Promise<void> {
    const parsed = sessionSchema.parse(session);
    return this.enqueue(() => this.mutate(state => {
      state.auth = parsed;
    }));
  }

  readSession(): Promise<SessionState | null> {
    return this.enqueue(async () => (await this.refresh()).auth ?? null);
  }

  clearAuth(): Promise<void> {
    return this.enqueue(() => this.mutate(state => {
      delete state.auth;
      delete state.privateJwk;
    }));
  }

  savePrivateJwk(privateJwk: Record<string, string>): Promise<void> {
    return this.enqueue(() => this.mutate(state => {
      state.privateJwk = privateJwk;
    }));
  }

  readPrivateJwk(): Promise<Record<string, string> | null> {
    return this.enqueue(async () => (await this.refresh()).privateJwk ?? null);
  }

  saveWatch(watch: z.input<typeof watchSchema>): Promise<void> {
    const parsed = watchSchema.parse(watch);
    return this.enqueue(() => this.mutate(state => {
      state.watches[parsed.watchId] = parsed;
    }));
  }

  deleteWatch(watchId: string): Promise<void> {
    return this.enqueue(() => this.mutate(state => {
      delete state.watches[watchId];
    }));
  }

  /** Copies, so a caller cannot mutate the store's records by alias. */
  listWatches(): Promise<WatchRecord[]> {
    return this.enqueue(async () => Object.values((await this.refresh()).watches).map(copyWatch).sort((left, right) => {
      const byTime = left.armedAt.localeCompare(right.armedAt);
      return byTime === 0 ? left.watchId.localeCompare(right.watchId) : byTime;
    }));
  }

  /** Records a store-wide dedupe key. Does not recreate a watch that was removed. */
  markFired(watchId: string, key: string, terminal: boolean): Promise<void> {
    return this.enqueue(() => this.mutate(state => {
      state.fired = pruneFired({ ...state.fired, [key]: new Date().toISOString() });
      const watch = state.watches[watchId];
      if (!watch) return;
      if (terminal) delete state.watches[watchId];
    }));
  }

  hasFired(key: string): Promise<boolean> {
    return this.enqueue(async () => {
      const state = await this.refresh();
      const at = state.fired[key];
      if (!at) return false;
      const time = Date.parse(at);
      return Number.isFinite(time) && time >= Date.now() - FIRED_MAX_AGE_MS;
    });
  }

  /** First observation of a bare watch. No-ops when the watch was removed. */
  setWatchBaseline(watchId: string, baselineRunId: string | null): Promise<void> {
    return this.enqueue(() => this.mutate(state => {
      const watch = state.watches[watchId];
      if (!watch) return;
      watch.baselineRunId = baselineRunId;
      watch.baselineSet = true;
    }));
  }

  recordOperation(operationId: string, payload: unknown): Promise<void> {
    return this.enqueue(() => this.mutate(state => {
      const existing = state.operations[operationId];
      if (existing) {
        if (stable(existing.payload) !== stable(payload)) {
          throw new BridgeError(
            "operation_conflict",
            "operation_conflict: this operationId was already saved with different arguments.",
          );
        }
        return;
      }
      state.operations[operationId] = { payload, savedAt: new Date().toISOString() };
    }));
  }

  getOperation(operationId: string): Promise<unknown> {
    return this.enqueue(async () => (await this.refresh()).operations[operationId]?.payload ?? null);
  }

  saveWebhook(webhook: WebhookConfig, name = DEFAULT_WEBHOOK_NAME): Promise<void> {
    const parsed = webhookSchema.parse(webhook);
    const webhookName = parseWebhookName(name);
    return this.enqueue(() => this.mutate(state => {
      state.webhooks[webhookName] = parsed;
    }));
  }

  deleteWebhook(name: string): Promise<boolean> {
    const webhookName = parseWebhookName(name);
    let removed = false;
    return this.enqueue(async () => {
      await this.mutate(state => {
        removed = Object.prototype.hasOwnProperty.call(state.webhooks, webhookName);
        delete state.webhooks[webhookName];
      });
      return removed;
    });
  }

  listWebhookNames(): Promise<string[]> {
    return this.enqueue(async () => Object.keys((await this.refresh()).webhooks).sort());
  }

  /** Names and URLs only. The secret stays in the state file. */
  listWebhooks(): Promise<Array<{ name: string; url: string }>> {
    return this.enqueue(async () => Object.entries((await this.refresh()).webhooks)
      .map(([name, config]) => ({ name, url: config.url }))
      .sort((left, right) => left.name.localeCompare(right.name)));
  }

  getWebhook(name: string): Promise<WebhookConfig | null> {
    return this.enqueue(async () => {
      const config = (await this.refresh()).webhooks[name];
      return config ? { url: config.url, secret: config.secret } : null;
    });
  }

  /** The legacy single slot. Named installs read `getWebhook`. */
  getWebhookConfig(): Promise<WebhookConfig | null> {
    return this.getWebhook(DEFAULT_WEBHOOK_NAME);
  }

  /**
   * Pick the webhook a new watch should store.
   * Zero registrations keep the name `default` so a later save can drain the queue.
   * Two or more require an explicit name. A missing name is not replaced with another URL.
   */
  resolveWakeTarget(requested?: string | null): Promise<{ name: string } | { code: "wake_target_missing" | "wake_target_required"; warning: string }> {
    const asked = requested?.trim() ?? "";
    return this.enqueue(async () => {
      const names = Object.keys((await this.refresh()).webhooks).sort();
      if (asked) {
        const parsed = parseWebhookName(asked);
        if (!names.includes(parsed)) {
          return {
            code: "wake_target_missing" as const,
            warning: `wake_target_missing: no webhook named "${parsed}" is registered.`,
          };
        }
        return { name: parsed };
      }
      if (names.length === 0) return { name: DEFAULT_WEBHOOK_NAME };
      if (names.length === 1) return { name: names[0] ?? DEFAULT_WEBHOOK_NAME };
      return {
        code: "wake_target_required" as const,
        warning: "wake_target_required: more than one webhook is registered. Pass wakeTarget.",
      };
    });
  }

  enqueueDelivery(entry: { id: string; event: unknown; attempts: number; lastError: string; nextAttemptAt?: string; parked?: boolean; queuedAt?: string }): Promise<void> {
    return this.enqueue(() => this.mutate(state => {
      state.deliveries = capDeliveries([...state.deliveries, {
        ...entry,
        queuedAt: entry.queuedAt ?? new Date().toISOString(),
        parked: entry.parked === true,
      }]);
    }));
  }

  /** Heartbeat lives outside state.json so a tick does not rewrite credentials. */
  async noteTick(at: string): Promise<void> {
    const path = join(this.dir, "runtime.json");
    const temp = join(this.dir, `.runtime-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify({ lastTickAt: at }), { mode: 0o600 });
    try {
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async readRuntime(): Promise<{ lastTickAt: string | null }> {
    try {
      const parsed = JSON.parse(await readFile(join(this.dir, "runtime.json"), "utf8")) as { lastTickAt?: unknown };
      if (typeof parsed.lastTickAt === "string" && parsed.lastTickAt.length > 0) return { lastTickAt: parsed.lastTickAt };
    } catch {
      // Older state files kept the heartbeat beside the credentials.
    }
    return this.enqueue(async () => ({ lastTickAt: (await this.refresh()).runtime?.lastTickAt ?? null }));
  }

  /** self when this process holds watcher.lock, other when a live pid does, otherwise none. */
  async watcherRole(): Promise<"self" | "other" | "none"> {
    const { pid } = await this.readWatcherLock();
    if (pid === null) return "none";
    if (pid === process.pid) return "self";
    return pidAlive(pid) ? "other" : "none";
  }

  async readWatcherLock(): Promise<{ pid: number | null }> {
    try {
      const pid = Number((await readFile(join(this.dir, "watcher.lock"), "utf8")).split("\n")[0]);
      return { pid: Number.isInteger(pid) && pid > 0 ? pid : null };
    } catch {
      return { pid: null };
    }
  }

  observeWatch(watchId: string, patch: { lastCheckedAt: string; lastStatus: string | null; lastError: string | null }): Promise<void> {
    return this.enqueue(async () => {
      const watch = (await this.refresh()).watches[watchId];
      if (!watch) return;
      const sameStatus = (watch.lastStatus ?? null) === patch.lastStatus;
      const sameError = (watch.lastError ?? null) === (patch.lastError ?? null);
      if (sameStatus && sameError && watch.lastCheckedAt) return;
      await this.mutate(state => {
        const current = state.watches[watchId];
        if (!current) return;
        current.lastCheckedAt = patch.lastCheckedAt;
        current.lastStatus = patch.lastStatus;
        current.lastError = patch.lastError;
      });
    });
  }

  adoptWatchRun(watchId: string, runId: string): Promise<void> {
    return this.enqueue(() => this.mutate(state => {
      const watch = state.watches[watchId];
      if (!watch) return;
      watch.runId = runId;
      watch.baselineSet = true;
    }));
  }

  releaseDeliveries(): Promise<void> {
    return this.enqueue(() => this.mutate(state => {
      for (const entry of state.deliveries) {
        entry.parked = false;
        entry.nextAttemptAt = new Date(0).toISOString();
      }
    }));
  }

  async purgeDeliveries(id?: string): Promise<number> {
    const current = await this.listDeliveries();
    const removed = id ? current.filter(entry => entry.id === id).length : current.length;
    await this.enqueue(() => this.mutate(state => {
      state.deliveries = id ? state.deliveries.filter(entry => entry.id !== id) : [];
    }));
    return removed;
  }

  removeDelivery(id: string): Promise<void> {
    return this.enqueue(() => this.mutate(state => {
      state.deliveries = state.deliveries.filter(entry => entry.id !== id);
    }));
  }

  /** Updates one queued delivery if it still exists. A purge during the POST is left alone. */
  patchDelivery(id: string, patch: { attempts: number; lastError: string; parked: boolean; nextAttemptAt?: string }): Promise<void> {
    return this.enqueue(() => this.mutate(state => {
      const index = state.deliveries.findIndex(entry => entry.id === id);
      const current = index >= 0 ? state.deliveries[index] : undefined;
      if (!current) return;
      const next = {
        ...current,
        attempts: patch.attempts,
        lastError: patch.lastError,
        parked: patch.parked,
      };
      if (patch.nextAttemptAt) next.nextAttemptAt = patch.nextAttemptAt;
      state.deliveries[index] = next;
    }));
  }

  replaceDeliveries(entries: DeliveryEntry[]): Promise<void> {
    return this.enqueue(() => this.mutate(state => {
      state.deliveries = capDeliveries(entries.map(entry => ({ ...entry })));
    }));
  }

  listDeliveries(): Promise<DeliveryEntry[]> {
    return this.enqueue(async () => (await this.refresh()).deliveries.map(entry => ({ ...entry })));
  }
}

function pruneJournal(state: State): void {
  const cutoff = Date.now() - JOURNAL_MAX_AGE_MS;
  const stamped = new Date().toISOString();
  for (const [id, entry] of Object.entries(state.operations)) {
    if (!entry.savedAt) {
      entry.savedAt = stamped;
      continue;
    }
    const time = Date.parse(entry.savedAt);
    if (Number.isFinite(time) && time < cutoff) delete state.operations[id];
  }
}

function copyWatch(watch: WatchRecord): WatchRecord {
  return {
    ...watch,
    firedTerminal: [...watch.firedTerminal],
    firedAttention: [...watch.firedAttention],
  };
}
