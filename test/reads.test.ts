import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDpopKey, Dpop } from "../src/dpop.js";
import { Http } from "../src/http.js";
import { fetchBounded, fetchHistory, fetchShell } from "../src/relay-http.js";
import { startFakeV2 } from "./fake-v2.js";

test("v2 reads accept oversized ids and extra fields without dropping the shell", async () => {
  const fake = await startFakeV2();
  const env = {
    origin: fake.origin,
    accessToken: "env-token",
    signer: new Dpop(generateDpopKey()),
    http: new Http(),
  };
  try {
    const shell = await fetchShell(env);
    assert.equal(shell.projects.length, 1);
    assert.equal(shell.projects[0]?.projectId, fake.projectId);
    assert.deepEqual(shell.projects[0]?.defaultModelSelection, { instanceId: "grok", model: "grok-4" });
    assert.equal(shell.threads.length, 1);
    assert.equal(shell.threads[0]?.threadId, fake.threadId);
    assert.ok(shell.warnings.length >= 1);
    assert.equal(JSON.stringify(shell).includes("weirdFutureField"), false);
    assert.equal(JSON.stringify(shell).includes("effort"), false);

    const bounded = await fetchBounded(env, fake.threadId);
    assert.equal(bounded.thread?.threadId, fake.threadId);
    assert.deepEqual(bounded.messages.map(message => message.text), ["hello menet2", "done"]);
    assert.equal(bounded.historyCursor, "older-1");
    assert.equal(JSON.stringify(bounded).includes("hide"), false);
    assert.ok(bounded.warnings.length >= 1);

    const history = await fetchHistory(env, fake.threadId, "older-1");
    assert.equal(history.messages[0]?.text, "cursor:older-1");
    assert.equal(history.hasMoreHistory, false);
    assert.ok(fake.seenProtocol.every(value => value === "2"));
  } finally {
    await fake.close();
  }
});
