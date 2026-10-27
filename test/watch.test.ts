import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Watcher, type RunSnapshot } from "../src/watch.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-watch-"));
  const store = await Store.load(dir);
  await store.saveWebhook({ url: "https://example.test/hooks/t3", secret: "whsec_test" });
  const posts: Array<{ url: string; authorization: string; body: unknown }> = [];
  const sleeps: number[] = [];
  const watcher = new Watcher(store, async (url, init) => {
    posts.push({
      url,
      authorization: String((init?.headers as Record<string, string>).authorization),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(null, { status: 204 });
  }, async ms => { sleeps.push(ms); });
  return { dir, store, watcher, posts, sleeps };
}

const base = {
  environmentId: "env-1",
  projectId: "proj-1",
  threadId: "thread-1",
  title: "Greeting",
  runId: "run-1",
};

test("watcher stays quiet while working and fires once on a terminal run", async () => {
  const { dir, store, watcher, posts } = await setup();
  try {
    await watcher.armWatch({ ...base, notifyOnAttention: false });
    const read = async (): Promise<RunSnapshot> => ({ runId: "run-1", status: "working", summary: "partial" });
    await watcher.tickWatches(read);
    assert.equal(posts.length, 0);
    const finished = async (): Promise<RunSnapshot> => ({ runId: "run-1", status: "finished", summary: "shipped the bridge" });
    await watcher.tickWatches(finished);
    await watcher.tickWatches(finished);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.url, "https://example.test/hooks/t3");
    assert.equal(posts[0]?.authorization, "Bearer whsec_test");
    const body = posts[0]?.body as Record<string, unknown>;
    const { eventId, occurredAt, ...stable } = body;
    assert.equal(typeof eventId, "string");
    assert.match(String(occurredAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(stable, {
      event: "t3.run.terminal",
      bridgeVersion: "0.1.0",
      environmentId: "env-1",
      projectId: "proj-1",
      threadId: "thread-1",
      title: "Greeting",
      runId: "run-1",
      status: "finished",
      summary: "shipped the bridge",
      wakeTarget: "default",
    });
    assert.equal((await store.listWatches()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attention notifications are opt-in and deduped per run and status", async () => {
  const { dir, watcher, posts } = await setup();
  try {
    await watcher.armWatch({ ...base, notifyOnAttention: false });
    const waiting = async (): Promise<RunSnapshot> => ({ runId: "run-1", status: "awaiting_approval", summary: "needs approval" });
    await watcher.tickWatches(waiting);
    assert.equal(posts.length, 0);
    await watcher.unwatchThread("thread-1");
    await watcher.armWatch({ ...base, runId: "run-2", notifyOnAttention: true });
    const attention = async (): Promise<RunSnapshot> => ({ runId: "run-2", status: "awaiting_input", summary: "which file?" });
    await watcher.tickWatches(attention);
    await watcher.tickWatches(attention);
    assert.equal(posts.length, 1);
    assert.equal((posts[0]?.body as { event: string }).event, "t3.run.attention");
    assert.equal((posts[0]?.body as { status: string }).status, "awaiting_input");
    const done = async (): Promise<RunSnapshot> => ({ runId: "run-2", status: "finished", summary: "answered" });
    await watcher.tickWatches(done);
    assert.equal(posts.length, 2);
    assert.equal((posts[1]?.body as { event: string }).event, "t3.run.terminal");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed posts retry three times and then sit in the delivery queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-watch-fail-"));
  const store = await Store.load(dir);
  await store.saveWebhook({ url: "https://example.test/hooks/t3", secret: "whsec_test" });
  let attempts = 0;
  const sleeps: number[] = [];
  const watcher = new Watcher(store, async () => {
    attempts += 1;
    return new Response("nope", { status: 502 });
  }, async ms => { sleeps.push(ms); });
  try {
    await watcher.armWatch({ ...base, notifyOnAttention: false });
    const summary = "s".repeat(600);
    await watcher.tickWatches(async () => ({ runId: "run-1", status: "failed", summary }));
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [200, 400]);
    const queued = await store.listDeliveries();
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.attempts, 3);
    const event = queued[0]?.event as { summary?: string };
    assert.equal(event.summary?.length, 500);
    assert.equal(event.summary?.endsWith("\n[truncated]"), true);
    attempts = 0;
    await watcher.tickWatches(async () => ({ runId: "run-1", status: "failed", summary }));
    assert.equal(attempts, 0);
    assert.equal((await store.listDeliveries()).length, 1);
    assert.equal((await store.listWatches()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
