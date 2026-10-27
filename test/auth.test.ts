import { createServer, type IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClerkAuth } from "../src/auth.js";
import { readConfig } from "../src/config.js";
import { Connect } from "../src/connect.js";
import { hash } from "../src/dpop.js";
import { Http } from "../src/http.js";
import { Store } from "../src/store.js";

const environmentId = "43972768-c214-40da-acbe-c9ea9a2e3bd4";
const curveOrder = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

interface Fake {
  origin: string;
  close: () => Promise<void>;
  counts: { dpop: number; oauth: number; connect: number };
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  if (req.headers["content-type"]?.includes("application/json")) return JSON.parse(raw) as Record<string, string>;
  return Object.fromEntries(new URLSearchParams(raw));
}

function assertProof(req: IncomingMessage, origin: string, accessToken?: string): void {
  const parts = String(req.headers.dpop).split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as { alg: string; typ: string; jwk: Record<string, string> };
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as { htm: string; htu: string; ath?: string };
  assert.equal(header.alg, "ES256");
  assert.equal(header.typ, "dpop+jwt");
  assert.equal(header.jwk.d, undefined);
  assert.equal(payload.htm, req.method);
  const target = new URL(req.url ?? "/", origin);
  target.search = "";
  target.hash = "";
  assert.equal(payload.htu, target.href);
  assert.equal(payload.ath, accessToken ? hash(accessToken) : undefined);
  const signature = Buffer.from(parts[2]!, "base64url");
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
  assert.ok(s <= curveOrder / 2n);
  assert.equal(verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: createPublicKey({ key: header.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    signature,
  ), true);
}

async function startFake(): Promise<Fake> {
  let clientJwt = "";
  let signInStatus = "needs_first_factor";
  const relayTokens = new Map<string, string>();
  const bootstraps = new Map<string, string>();
  const counts = { dpop: 0, oauth: 0, connect: 0 };
  const accountJwt = `h.${Buffer.from(JSON.stringify({ sub: "user_lqb" })).toString("base64url")}.sig`;
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = new URL(req.url ?? "/", origin);
    const body = await readBody(req);
    const respond = (data: unknown, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    const attempt = () => ({
      id: "sia_1",
      status: signInStatus,
      created_session_id: signInStatus === "complete" ? "sess_1" : null,
      supported_first_factors: [{ strategy: "email_code", email_address_id: "email_1" }],
      supported_second_factors: [{ strategy: "totp" }],
    });
    if (url.pathname.startsWith("/v1/client/") && url.pathname !== "/v1/client/dpop-token") {
      assert.equal(url.searchParams.get("_is_native"), "1");
      if (req.headers.authorization && req.headers.authorization !== clientJwt && clientJwt) {
        respond({ errors: [{ code: "signed_out" }] }, 401);
        return;
      }
      clientJwt = `native-client-${clientJwt.length + 1}`;
      if (url.pathname === "/v1/client/sign_ins" && req.method === "POST") {
        assert.equal(body.identifier, "lqb@yomolo.com");
        signInStatus = "needs_first_factor";
        respond({ response: attempt() }, 200, { authorization: clientJwt });
        return;
      }
      if (url.pathname.endsWith("/prepare_first_factor")) {
        assert.equal(body.strategy, "email_code");
        assert.equal(body.email_address_id, "email_1");
        respond({ response: attempt() }, 200, { authorization: clientJwt });
        return;
      }
      if (url.pathname.endsWith("/attempt_first_factor")) {
        if (body.code !== "123456") {
          respond({ errors: [{ code: "form_code_incorrect" }] }, 422, { authorization: clientJwt });
          return;
        }
        signInStatus = "complete";
        respond({ response: attempt() }, 200, { authorization: clientJwt });
        return;
      }
      if (url.pathname.endsWith("/tokens/t3-relay")) {
        respond({ jwt: accountJwt }, 200, { authorization: clientJwt });
        return;
      }
      if (url.pathname.endsWith("/end")) {
        respond({ response: { id: "sess_1", status: "ended" } }, 200, { authorization: clientJwt });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/client/sign_ins/sia_1") {
        respond({ response: attempt() }, 200, { authorization: clientJwt });
        return;
      }
    }
    if (url.pathname === "/v1/environments" && req.method === "GET") {
      assert.equal(req.headers.authorization, `Bearer ${accountJwt}`);
      const endpoint = { httpBaseUrl: `${origin}/`, wsBaseUrl: origin.replace("http:", "ws:") + "/ws", providerKind: "t3_relay", extra: true };
      respond({ environments: [{ environmentId, label: "menet2", endpoint, linkedAt: "2026-10-25T00:00:00.000Z", future: { nested: true } }] });
      return;
    }
    if (url.pathname === "/v1/client/dpop-token") {
      assert.equal(body.client_id, "t3-web");
      assert.equal(body.subject_token, accountJwt);
      assertProof(req, origin);
      counts.dpop += 1;
      const token = `relay-${counts.dpop}`;
      relayTokens.set(token, "1");
      respond({ access_token: token, token_type: "DPoP", expires_in: 3600, scope: body.scope, extra: true });
      return;
    }
    const connectMatch = /^\/v1\/environments\/([^/]+)\/connect$/.exec(url.pathname);
    if (connectMatch && req.method === "POST") {
      const token = req.headers.authorization?.replace("DPoP ", "") ?? "";
      assert.ok(relayTokens.has(token));
      assertProof(req, origin, token);
      assert.equal(decodeURIComponent(connectMatch[1]!), environmentId);
      const thumbprint = body.clientProofKeyThumbprint ?? "";
      assert.ok(thumbprint.length > 10);
      counts.connect += 1;
      const credential = `bootstrap-${counts.connect}`;
      bootstraps.set(credential, token);
      const endpoint = { httpBaseUrl: `${origin}/`, wsBaseUrl: origin.replace("http:", "ws:") + "/ws", providerKind: "t3_relay" };
      respond({ environmentId, endpoint, credential, expiresAt: "2026-10-25T12:00:00.000Z", extra: true });
      return;
    }
    if (url.pathname === "/oauth/token") {
      assert.ok(body.subject_token && bootstraps.has(body.subject_token));
      assert.equal(body.subject_token_type, "urn:t3:params:oauth:token-type:environment-bootstrap");
      assert.equal(body.client_label, "t3-bridge");
      assertProof(req, origin);
      counts.oauth += 1;
      respond({ access_token: `env-token-${counts.oauth}`, token_type: "DPoP", expires_in: 3600, scope: body.scope });
      return;
    }
    respond({ code: "not_found" }, 404);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(() => resolve())), counts };
}

async function harness(origin: string) {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-auth-"));
  const config = readConfig({
    T3_BRIDGE_STATE_DIR: dir,
    T3_BRIDGE_CLERK_ORIGIN: origin,
    T3_BRIDGE_RELAY_ORIGIN: origin,
  } as NodeJS.ProcessEnv);
  const store = await Store.load(dir);
  const http = new Http();
  const auth = new ClerkAuth(config, http, store);
  return { dir, config, store, http, auth };
}

test("email-code login exchanges a DPoP environment session and stores neither the email nor the code", async () => {
  const fake = await startFake();
  const { dir, config, store, http, auth } = await harness(fake.origin);
  try {
    assert.deepEqual(await auth.loginStatus(), { status: "signed_out" });
    const pending = await auth.loginStart("lqb@yomolo.com");
    assert.equal(pending.status, "code_required");
    if (pending.status !== "code_required") return;
    assert.equal(pending.factor, "email_code");
    await assert.rejects(
      () => auth.loginVerify({ loginId: pending.loginId, code: "000000" }),
      (error: { code?: string; details?: { reason?: string } }) => error.code === "http_error" && error.details?.reason === "form_code_incorrect",
    );
    const verified = await auth.loginVerify({ loginId: pending.loginId, code: "123456" });
    assert.deepEqual(verified, { status: "signed_in" });
    const connect = new Connect(config, http, auth, store);
    const listed = await connect.listEnvironments();
    assert.equal(listed.environments[0]?.environmentId, environmentId);
    assert.equal(listed.environments[0]?.label, "menet2");
    assert.deepEqual(listed.warnings, []);
    const first = await connect.acquireEnvironmentCredential(environmentId);
    const second = await connect.acquireEnvironmentCredential(environmentId);
    assert.equal(first.accessToken, second.accessToken);
    assert.equal(first.origin, fake.origin);
    assert.equal(first.wsUrl, fake.origin.replace("http:", "ws:") + "/ws");
    assert.equal(fake.counts.oauth, 1);
    const stored = await readFile(join(dir, "state.json"), "utf8");
    assert.equal(stored.includes("lqb@yomolo.com"), false);
    assert.equal(stored.includes("123456"), false);
    assert.equal(stored.includes("000000"), false);
    assert.equal(stored.includes(first.accessToken), false);
    assert.equal(stored.includes(".sig"), false);
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function cli(args: string[], env: Record<string, string>, input?: unknown) {
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src/cli.ts"), ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  return once(child, "close").then(([code]) => ({ code, stdout, stderr }));
}

test("cli login-status is signed_out and environments works after login-verify", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-bridge-cli-"));
  const fake = await startFake();
  const env = {
    T3_BRIDGE_STATE_DIR: dir,
    T3_BRIDGE_CLERK_ORIGIN: fake.origin,
    T3_BRIDGE_RELAY_ORIGIN: fake.origin,
  };
  try {
    const status = await cli(["login-status"], env);
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), { status: "signed_out" });
    const started = await cli(["login-start"], env, { email: "lqb@yomolo.com" });
    assert.equal(started.code, 0, started.stderr);
    const pending = JSON.parse(started.stdout) as { status: string; loginId: string; factor: string };
    assert.equal(pending.status, "code_required");
    const verified = await cli(["login-verify"], env, { loginId: pending.loginId, factor: pending.factor, code: "123456" });
    assert.equal(verified.code, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout), { status: "signed_in" });
    const listed = await cli(["environments"], env);
    assert.equal(listed.code, 0, listed.stderr);
    const body = JSON.parse(listed.stdout) as { environments: Array<{ environmentId: string; label: string }> };
    assert.equal(body.environments[0]?.environmentId, environmentId);
    assert.equal(body.environments[0]?.label, "menet2");
    const combined = `${status.stdout}${started.stdout}${verified.stdout}${listed.stdout}${listed.stderr}`;
    assert.equal(combined.includes("native-client"), false);
    assert.equal(combined.includes("env-token"), false);
    assert.equal(combined.includes("123456"), false);
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});
