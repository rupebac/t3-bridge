#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ClerkAuth, loginStartInput, loginVerifyInput } from "./auth.js";
import { openBridge } from "./bridge.js";
import { readConfig, type Config } from "./config.js";
import { toEnvironmentListResult } from "./contracts.js";
import { Connect } from "./connect.js";
import { BridgeError, errorResult, logDebug } from "./errors.js";
import { Http } from "./http.js";
import { importSession } from "./import-session.js";
import { createServer } from "./server.js";
import { Store } from "./store.js";
import { VERSION } from "./version.js";
import { parseWebhookName, webhookUrl } from "./webhook.js";

const help = `t3-bridge ${VERSION} — stdio MCP bridge for T3 Code on menet2

Commands:
  serve          Serve the MCP tools on stdio (default)
  login          Sign in with an email code in this terminal
  login-start    Send an email code; read {"email":"..."} from stdin
  login-verify   Submit {"loginId":"...","code":"..."} from stdin
  login-status   Show signed_out, code_required, or signed_in
  logout         End this bridge's session
  environments   List machines linked to the signed-in account
  webhook        Save, list, or delete named routine webhooks
                 webhook                 save {"url","secret"} as "default"
                 webhook --name <name>   save stdin under that name
                 webhook list            list names and urls, never secrets
                 webhook delete --name <name>
  import-session Copy a t3code-mcp account session into this bridge
  deliveries     list, replay, or purge queued webhook deliveries
  capture-fixtures --thread <id> [--redact-text]
                 Write raw and parsed shell, bounded, and history JSON.
                 --redact-text replaces non-structural strings with lengths.
  --version      Print the version
  --help         Show this help

Set T3_BRIDGE_DEBUG=1 to print error codes and stack frames on stderr. Remote bodies are not logged.

State directory: ~/.t3-bridge (override T3_BRIDGE_STATE_DIR).
Login, webhook, and import commands print status JSON only. They never print session tokens.
Suggested MCP server name: t3bridge.
`;

const webhookInput = z.object({
  url: z.string().url(),
  secret: z.string().min(8).max(500),
});

function parseInput<T>(schema: z.ZodType<T>, value: unknown, invalidMessage = "Invalid login input. Verification codes must be six digits."): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BridgeError("invalid_input", invalidMessage);
  return parsed.data;
}

async function readStdin<T>(schema: z.ZodType<T>, invalidMessage?: string): Promise<T> {
  if (process.stdin.isTTY) throw new BridgeError("stdin_required", "Pass a JSON object through stdin, or use login for interactive prompts.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 8192) throw new BridgeError("invalid_input", "Login input exceeds 8 KB.");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return parseInput(schema, JSON.parse(Buffer.concat(chunks).toString("utf8")), invalidMessage);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("invalid_input", "Pass one JSON object through stdin.");
  }
}

async function openAuth() {
  const config = readConfig();
  const store = await Store.load(config.stateDir);
  const http = new Http();
  return { config, store, http, auth: new ClerkAuth(config, http, store) };
}


async function serve(config: Config, store: Store, http: Http): Promise<void> {
  const bridge = await openBridge(config, store, http);
  const server = createServer(bridge);
  let leader = false;
  const release = () => {
    if (!leader) return;
    leader = false;
    store.releaseWatcherSync();
  };
  const tick = () => {
    void (async () => {
      if (!leader) {
        leader = await store.tryAcquireWatcher();
        if (!leader) return;
      }
      await bridge.tickWatches();
    })().catch(error => {
      logDebug(error);
      process.stderr.write(`${JSON.stringify(errorResult(error))}\n`);
    });
  };
  const timer = setInterval(tick, 5_000);
  timer.unref();
  const stop = (code: number) => {
    clearInterval(timer);
    release();
    process.exit(code);
  };
  process.once("exit", () => {
    clearInterval(timer);
    release();
  });
  process.once("SIGINT", () => stop(130));
  process.once("SIGTERM", () => stop(143));
  await server.connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "serve";
  const extras = args.slice(1);
  if (extras.length > 0 && command !== "deliveries" && command !== "capture-fixtures" && command !== "webhook") {
    throw new BridgeError("usage", "No positional credentials or extra arguments are accepted. Run --help.");
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(help);
    return;
  }
  const { config, store, http, auth } = await openAuth();
  if (command === "serve") {
    await serve(config, store, http);
    return;
  }
  if (command === "webhook") {
    await webhookCommand(extras, store);
    return;
  }
  if (command === "import-session") {
    const source = process.env.T3_CODE_MCP_STATE_DIR ?? resolve(homedir(), ".t3code-mcp");
    process.stdout.write(`${JSON.stringify(await importSession(source, store, config))}\n`);
    return;
  }
  if (command === "login-status") {
    process.stdout.write(`${JSON.stringify(await auth.loginStatus())}\n`);
    return;
  }
  if (command === "login-start") {
    const input = await readStdin(loginStartInput);
    process.stdout.write(`${JSON.stringify(await auth.loginStart(input.email))}\n`);
    return;
  }
  if (command === "login-verify") {
    const input = await readStdin(loginVerifyInput);
    process.stdout.write(`${JSON.stringify(await auth.loginVerify(input))}\n`);
    return;
  }
  if (command === "logout") {
    await auth.logout();
    process.stderr.write("This bridge's account session has been cleared.\n");
    return;
  }
  if (command === "login") {
    if (!process.stdin.isTTY) throw new BridgeError("terminal_required", "Use login in an interactive terminal, or login-start and login-verify with JSON stdin.");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      let status = await auth.loginStatus();
      if (status.status === "signed_out") {
        const email = parseInput(loginStartInput, { email: await rl.question("T3 account email: ") }).email;
        status = await auth.loginStart(email);
      }
      while (status.status === "code_required") {
        const code = await rl.question(status.factor === "email_code" ? "Email verification code: " : "Authenticator code: ");
        status = await auth.loginVerify({ loginId: status.loginId, factor: status.factor, code });
      }
      if (status.status !== "signed_in") throw new BridgeError("login_restart_required", "The pending login expired. Run logout, then login again.");
    } finally {
      rl.close();
    }
    process.stderr.write("Account session saved.\n");
    return;
  }
  if (command === "deliveries") {
    await deliveriesCommand(extras, store);
    return;
  }
  if (command === "capture-fixtures") {
    await captureCommand(extras, config, store, http);
    return;
  }
  if (command === "environments") {
    const connect = new Connect(config, http, auth, store);
    const linked = await connect.listEnvironments();
    const result = toEnvironmentListResult({
      environments: linked.environments.map(environment => ({
        environmentId: environment.environmentId,
        label: environment.label,
        endpoint: environment.httpBaseUrl,
        availability: "unchecked" as const,
      })),
      total: linked.environments.length,
      nextOffset: null,
      warnings: linked.warnings,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new BridgeError("usage", "Unknown command. Run t3-bridge --help.");
}

function webhookCommandArgs(extras: string[]): { action: "save" | "list" | "delete"; name?: string } {
  let action: "save" | "list" | "delete" | null = null;
  let name: string | undefined;
  for (let index = 0; index < extras.length; index += 1) {
    const arg = extras[index] ?? "";
    if (arg === "list" || arg === "--list") {
      if (action && action !== "list") throw new BridgeError("usage", "Use webhook, webhook list, or webhook delete --name <name>.");
      action = "list";
      continue;
    }
    if (arg === "delete" || arg === "--delete") {
      if (action && action !== "delete") throw new BridgeError("usage", "Use webhook, webhook list, or webhook delete --name <name>.");
      action = "delete";
      continue;
    }
    if (arg === "--name") {
      const next = extras[index + 1];
      if (!next || next.startsWith("-")) throw new BridgeError("usage", "webhook --name needs a name.");
      if (name) throw new BridgeError("usage", "Pass --name once.");
      name = next;
      index += 1;
      continue;
    }
    throw new BridgeError("usage", "Use webhook, webhook list, or webhook delete --name <name>.");
  }
  if ((action ?? "save") === "delete" && !name) throw new BridgeError("usage", "webhook delete needs --name <name>.");
  return { action: action ?? "save", ...(name ? { name } : {}) };
}

async function webhookCommand(extras: string[], store: Store): Promise<void> {
  const { action, name } = webhookCommandArgs(extras);
  if (action === "list") {
    const webhooks = await store.listWebhooks();
    const visible = name ? webhooks.filter(webhook => webhook.name === name) : webhooks;
    process.stdout.write(`${JSON.stringify({ webhooks: visible })}\n`);
    return;
  }
  if (action === "delete") {
    const webhookName = parseWebhookName(name ?? "");
    process.stdout.write(`${JSON.stringify({ deleted: await store.deleteWebhook(webhookName), name: webhookName })}\n`);
    return;
  }
  const webhookName = parseWebhookName(name ?? "default");
  const input = await readStdin(webhookInput, "Webhook input needs a url and a secret of at least 8 characters.");
  await store.saveWebhook({ url: webhookUrl(input.url), secret: input.secret }, webhookName);
  process.stdout.write(`${JSON.stringify({ saved: true, name: webhookName })}\n`);
}

async function deliveriesCommand(extras: string[], store: Store): Promise<void> {
  const action = extras[0] ?? "list";
  if (extras.length > 1 || !["list", "replay", "purge"].includes(action)) {
    throw new BridgeError("usage", "Use deliveries list, deliveries replay, or deliveries purge.");
  }
  if (action === "purge") {
    process.stdout.write(`${JSON.stringify({ removed: await store.purgeDeliveries() })}\n`);
    return;
  }
  if (action === "list") {
    const deliveries = (await store.listDeliveries()).map(entry => {
      const event = entry.event && typeof entry.event === "object" ? entry.event as Record<string, unknown> : {};
      return {
        id: entry.id,
        event: typeof event.event === "string" ? event.event : "unknown",
        threadId: typeof event.threadId === "string" ? event.threadId : null,
        runId: typeof event.runId === "string" ? event.runId : null,
        attempts: entry.attempts,
        lastError: entry.lastError,
        parked: entry.parked === true,
        nextAttemptAt: entry.nextAttemptAt ?? null,
        wakeTarget: typeof event.wakeTarget === "string" ? event.wakeTarget : null,
      };
    });
    process.stdout.write(`${JSON.stringify({ deliveries })}\n`);
    return;
  }
  const { config, http } = { config: readConfig(), http: new Http() };
  const bridge = await openBridge(config, store, http);
  process.stdout.write(`${JSON.stringify(await bridge.replayDeliveries())}\n`);
}

function captureArgs(extras: string[]): { threadId: string; redactText: boolean } {
  let threadId = "";
  let redactText = false;
  for (let index = 0; index < extras.length; index += 1) {
    const arg = extras[index] ?? "";
    if (arg === "--redact-text") {
      redactText = true;
      continue;
    }
    if (arg === "--thread") {
      const next = extras[index + 1];
      if (!next || next.startsWith("--")) throw new BridgeError("usage", "Use capture-fixtures --thread <threadId> [--redact-text].");
      if (threadId) throw new BridgeError("usage", "Use capture-fixtures --thread <threadId> [--redact-text].");
      threadId = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--") || threadId) throw new BridgeError("usage", "Use capture-fixtures --thread <threadId> [--redact-text].");
    threadId = arg;
  }
  if (!threadId) throw new BridgeError("usage", "Use capture-fixtures --thread <threadId> [--redact-text].");
  return { threadId, redactText };
}

async function captureCommand(extras: string[], config: Config, store: Store, http: Http): Promise<void> {
  const { threadId, redactText } = captureArgs(extras);
  const bridge = await openBridge(config, store, http);
  const snapshot = await bridge.captureSnapshot(threadId, { redactText });
  const dir = join(config.stateDir, "captures", threadId.replace(/[^A-Za-z0-9._-]/g, "_"));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "snapshot.json");
  await writeFile(path, JSON.stringify(snapshot), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ saved: path })}\n`);
}

main().catch(error => {
  logDebug(error);
  process.stderr.write(`${JSON.stringify(errorResult(error))}\n`);
  process.exitCode = 1;
});
