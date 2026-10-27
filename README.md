# t3-bridge

Stdio MCP server for [T3 Code](https://t3.codes). It talks to a T3 environment through the T3 Connect relay and DPoP, and it can POST a webhook when a prompt run finishes so an orchestrator can wake up.

This is a separate package. It does not patch or import [t3code-mcp](https://github.com/emmsixx/t3code-mcp) at runtime. Live v2 payloads are parsed with tolerant codecs, and the MCP results stay small and stable.

Repository: [ruben-perez-bachiller/t3-bridge](https://cursor.com/codebase/ruben-perez-bachiller/t3-bridge).

## Who it is for

Use it when an agent needs to list projects and threads, start or continue a thread, and hear back when that run ends. The bridge does not approve permission prompts and does not create worktrees. Those stay in the T3 client.

The built-in default environment is **menet2** (`43972768-c214-40da-acbe-c9ea9a2e3bd4`). That id only works for the account that owns that machine. Point the bridge at your own environment with `T3_BRIDGE_ENVIRONMENT_ID`.

## Requirements

- Node.js 22 or newer
- pnpm
- A T3 Connect account that can reach the environment

## Install

```bash
pnpm install
pnpm test
pnpm check
pnpm build
```

`pnpm build` writes `dist/cli.js`. The `t3-bridge` bin is that file. During development, `node --import tsx src/cli.ts` runs the same commands.

`package.json` declares the license as MIT.

## Login

```bash
t3-bridge login
t3-bridge login-status
t3-bridge environments
t3-bridge logout
```

`login` asks for the email and the one-time code in the terminal. Noninteractive callers pass JSON on stdin and never pass the code as an argument:

```bash
printf '%s\n' '{"email":"you@example.com"}' | t3-bridge login-start
printf '%s\n' '{"loginId":"...","factor":"email_code","code":"123456"}' | t3-bridge login-verify
```

To copy a local `t3code-mcp` session without printing tokens:

```bash
T3_CODE_MCP_STATE_DIR=~/.t3code-mcp t3-bridge import-session
```

That copies the account session and DPoP key and rebinds them to this bridge. It does not copy the old operation journal. When `T3_CODE_MCP_STATE_DIR` is unset, the source is `~/.t3code-mcp`.

State lives in `~/.t3-bridge` (directory `0700`, files `0600`). Override it with `T3_BRIDGE_STATE_DIR`. Each write takes `state.lock` and re-reads `state.json` first, so login, webhook, and import do not erase watches held by a running `serve`.

Optional overrides: `T3_BRIDGE_CLERK_ORIGIN` (default `https://clerk.t3.codes`), `T3_BRIDGE_RELAY_ORIGIN` (default `https://relay.t3.codes`), `T3_BRIDGE_JWT_TEMPLATE` (default `t3-relay`), `T3_BRIDGE_ENVIRONMENT_ID`.

The account relay is `https://relay.t3.codes`. The environment tunnel URL is discovered at connect time.

## MCP config

Server name: `t3bridge`.

```json
{
  "mcpServers": {
    "t3bridge": {
      "command": "t3-bridge",
      "args": ["serve"]
    }
  }
}
```

`t3-bridge` with no arguments also serves stdio. Only one `serve` process holds `watcher.lock` and polls watches. A second `serve` still answers tools and does not send a second webhook. SIGINT and SIGTERM release the lock. The package speaks orchestration v2 only.

## Tools

`environmentId` defaults to the configured environment. New threads use `runtimeMode: "approval-required"` unless you pass another mode. `full-access` is used only when the caller passes it. Launches use the project root. If a project's default checkout is a worktree, `start_thread` returns `worktree_unsupported`.

Reads:

- `list_environments`
- `list_projects`
- `list_threads`
- `get_thread` — pages with an opaque `tb1.` cursor anchored to the oldest message id. Pass it back as `beforeCursor`. If the bounded header has no status, the detail status follows the latest run, so it matches `list_threads` when the shell row already has a status.

Mutations. Pass a fresh `operationId` on each call, and send the same id again to retry that call.

- `start_thread`
- `send_message`
- `interrupt_thread`
- `set_thread_model`
- `set_thread_runtime`
- `rename_thread`

Watches:

- `watch_thread` — follows the active run. An idle thread waits for a newer run and does not notify for the run that already finished.
- `unwatch_thread` — clears every watch on a thread, or one watch when `watchId` is set.
- `list_watches`

Orchestrator helpers:

- `bridge_status` — `signedIn` is true only after sign-in completes. `webhookConfigured` is true when at least one webhook name is registered. `webhookNames` lists those names and does not include secrets.
- `register_webhook`, `list_webhooks`, `delete_webhook` — manage the named webhook registry without a shell. The secret is stored and never returned.
- `wait_thread` — waits until that prompt is terminal or needs attention, at most 50 seconds. Pass `userMessageId` or `operationId` from the ack. It does not approve permissions.
- `list_deliveries`
- `replay_deliveries`

`start_thread` and `send_message` arm a webhook watch unless `watch` is `false`. Each prompt keeps its own watch, matched by the `userMessageId` on the ack. A second send does not remove the first prompt's watch. `restart` does not pin the interrupted run. `steer` follows the active run. A terminal fallback waits one poll and is skipped when a newer run already exists. Without ordinals, a run is newer only when it appears later in the snapshot or has a later created time. Watches expire after 24 hours (`t3.watch.expired`).

## Webhooks

Each agent that should wake registers its own routine under a short name (`t3code`, `huivou`). A watch stores that name as `wakeTarget`. Terminal and attention delivery POSTs only to that webhook. It does not fall back to another agent's URL.

An existing single `webhook` entry is migrated to the name `default`, so a current install keeps working.

```bash
# bare save updates the name "default"
printf '%s\n' '{"url":"https://example.com/hooks/t3code","secret":"replace-me"}' | t3-bridge webhook

# a second agent
printf '%s\n' '{"url":"https://example.com/hooks/huivou","secret":"replace-me-too"}' | t3-bridge webhook --name huivou

t3-bridge webhook list
t3-bridge webhook delete --name huivou
```

`webhook list` prints names and URLs. It never prints secrets. `register_webhook` does the same from MCP: omit `name` to update `default`.

Pass `wakeTarget` on `start_thread`, `send_message`, and `watch_thread`.

- A provided name must already be registered. Otherwise the arm fails with `wake_target_missing`. `start_thread` and `send_message` still accept the mutation and return `watched: false` plus that warning.
- If you omit it and exactly one webhook is registered, that name is used, even when the name is not `default`.
- If you omit it and none are registered, the watch still arms as `default` and the event is queued with `webhook_not_configured`.
- If you omit it and more than one webhook is registered, the arm fails with `wake_target_required`. The bridge does not guess.

Delivery is `POST` with `Authorization: Bearer <secret>`, an `Idempotency-Key` equal to `eventId`, and a body like this. `eventId` is a hash of the event, run id, and status, so a retry keeps the same key. Expiry events hash the watch id. `wakeTarget` is included so a log can show which name was chosen.

```json
{
  "event": "t3.run.terminal",
  "eventId": "...",
  "occurredAt": "2026-10-25T12:00:00.000Z",
  "bridgeVersion": "0.1.0",
  "environmentId": "...",
  "projectId": "...",
  "threadId": "...",
  "title": "...",
  "runId": "...",
  "status": "finished",
  "summary": "short assistant excerpt",
  "wakeTarget": "t3code"
}
```

`planReady` is included only when a finished plan still needs approval. Attention events can include `attention: { "kind": "command" }`.

By default the bridge notifies **once per `runId`** when that run reaches a terminal status: `finished`, `failed`, `interrupted`, `stopped`, `cancelled`, or `rolled_back`. Working statuses do not notify.

Set `notifyOnAttention: true` on `start_thread`, `send_message`, or `watch_thread` to also emit `t3.run.attention` for `awaiting_approval`, `awaiting_input`, and `plan_ready`. Those fire at most once per `(runId, status)`.

The poster tries three times (200 ms, then 400 ms). Each POST times out after 10 seconds. A 400, 401, 403, 404, or 410 parks the delivery. Other failures wait 30 seconds, then 60, up to an hour. While an unparked transport or HTTP 5xx delivery is still backing off, new events are queued and not posted. Replay sends the oldest queued event first, at most 5 per tick. The watch is removed after the terminal event, and the same `runId` is not notified again.

If the watch's name is not in the registry, the event is queued with `webhook_not_configured` and `list_watches` warns. That queue entry is not sent to a different name. `list_watches` also reports `pendingDeliveries`. A queued event is replayed to the `wakeTarget` stored on that event. Older queued events with no name replay to `default`.

## CLI

```bash
t3-bridge deliveries list
t3-bridge deliveries replay
t3-bridge deliveries purge
t3-bridge capture-fixtures --thread <id> [--redact-text]
```

`deliveries` manages the webhook queue and does not print the secret. `capture-fixtures` writes the raw relay JSON beside the parsed view for one thread. `--redact-text` replaces every string except structural ids, types, kinds, statuses, and timestamps with its character length.

`bridge_status` and `wait_thread` are MCP tools, not CLI commands. `T3_BRIDGE_DEBUG=1` prints error codes and stack frames on stderr. Remote bodies are not logged.

## Security

- Login, webhook, import, and delivery commands print status JSON only. They do not print session tokens or the webhook secret.
- State files are mode `0600` in a `0700` directory.
- `capture-fixtures` always removes secret-shaped keys, JWTs, and strings that start with `sk-`, `ghp_`, `github_pat_`, or `xox`. Use `--redact-text` before sharing a capture.
- Do not commit `~/.t3-bridge`, captured fixtures, or anything under `uploads/`.

## Status

Reviewed across several Opus passes on this repository (0 High findings on the last full pass) and exercised live against menet2, including list/get status alignment. Automated tests use fakes and do not call live T3.

`t3.run.attention` and `planReady` are still experimental until a raw menet2 capture confirms those payload shapes.

Design notes: [docs/superpowers/specs/2026-10-25-t3-bridge-design.md](docs/superpowers/specs/2026-10-25-t3-bridge-design.md) and [docs/superpowers/plans/2026-10-25-t3-bridge.md](docs/superpowers/plans/2026-10-25-t3-bridge.md). The spec is the original draft. The behavior above is what the code does now.
