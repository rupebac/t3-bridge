# T3 Bridge — Design Spec

**Date:** 2026-10-25  
**Owner:** T3Code (Grok Bot) for Ruben Perez Bachiller  
**Status:** Draft for user review  
**Approach:** B — greenfield MCP bridge (not a fork of emmsixx/t3code-mcp)

## 1. Problem

The installed `user-t3code` connector (`t3code-mcp` 0.3.0 / orchestration-v2 prep) returns `incompatible_response` on `list_projects`, `list_threads`, and often `start_thread`, while `list_environments` and some `send_message` calls still work. Root cause class: strict Zod (or host) schemas that reject live T3 orchestration **v2** payloads (unknown fields, long IDs, shape drift). Workarounds (sqlite on menet2, T3 web UI) are slow and violate the goal of **API-only** control.

Ruben wants a **custom, thinner, more capable** bridge tailored to **menet2**, speaking T3 Connect relay + DPoP, with **webhook wakes** to T3Code when a prompt finishes.

## 2. Goals

1. Reliable MCP control of T3 on menet2 **without any web UI**.
2. Stable tool results that Grok Bot’s MCP host accepts (no `incompatible_response` from schema mismatch on our side).
3. Tool surface at least as strong as t3code-mcp’s seven tools, plus model/runtime/rename and watch/notify.
4. Push notification to T3Code when a watched run reaches a terminal or human-attention state.
5. Reuse Connect account `lqb@yomolo.com`; never paste tokens, pairing secrets, or credentials into chat.

## 3. Non-goals (v1)

- Approving permission prompts or answering `awaiting_input` from the bridge (still in T3 clients).
- Worktree creation / setup-script orchestration beyond what T3 does on launch.
- Multi-account Connect support.
- Replacing T3 itself or scraping undocumented local AppImage APIs for credentials.
- Running the bridge process on menet2 (v1 runs on the Grok Bot box).

## 4. Architecture

```
Grok Bot (T3Code)
    │ stdio MCP
    ▼
t3-bridge (Node 22+, TypeScript)
    ├─ Auth: Clerk session + DPoP (same class as t3code-mcp)
    ├─ Relay client: HTTP + WS to menet2 via T3 Connect
    ├─ Tolerant v2 codecs (strip/ignore unknown; long IDs)
    ├─ Stable outbound MCP schemas (small, versioned JSON)
    └─ Watcher → HTTPS POST webhook → Grok Bot routine → wakes T3Code
```

**Default environment:** menet2  
`environmentId = 43972768-c214-40da-acbe-c9ea9a2e3bd4`  
Relay: `https://prod-5b0033d0c6e7d351.t3coderelay.com/`

Secondary env `nb-xhjxw7rj9l` may be listed but is out of primary SLA.

**Process placement:** Grok Bot box (`/home/box/...`), stdio MCP entrypoint. Optional later: systemd user service for the watcher if stdio lifecycle is too short — v1 keeps watcher **in-process** while MCP is connected, and documents that watches pause if the MCP client disconnects (mitigation: short reconnect + rehydrate watches from state file).

## 5. Protocol strategy

- Detect orchestration protocol per environment (v1 vs v2). Menet2 is **v2**.
- **Inbound (T3 → bridge):** best-effort parse. Prefer `z.object({...}).passthrough()` / strip-unknown. Cap string IDs at ≥2000 chars. Never fail an entire list because one row is odd — skip or partial-map that row with an `warnings[]` entry.
- **Outbound (bridge → Grok Bot):** fixed, documented response shapes. No leaking raw unbounded T3 projections into MCP results.
- **Mutations:** WebSocket RPC with `orchestrationProtocol=2`, same high-level commands as t3code-mcp (`launchThread`, follow-up modes, interrupt by `runId`). Fresh `operationId` per intent; retries reuse id + args.
- Learn from `/home/box/opt/t3code-mcp` (auth, DPoP, journal) but **do not** depend on that package at runtime. Copy patterns, not a fragile import.

## 6. MCP tools (v1)

| Tool | Purpose |
| --- | --- |
| `list_environments` | Linked machines; optional availability probe |
| `list_projects` | Projects + model defaults on one env |
| `list_threads` | Unarchived threads; filter project/status; paginate |
| `get_thread` | Bounded messages + runtime status; cursor for older history |
| `start_thread` | Create + instruct; modelSelection; runtimeMode default `approval-required` |
| `send_message` | Follow-up; modes `auto` \| `queue` \| `steer` \| `restart` |
| `interrupt_thread` | Interrupt active run |
| `set_thread_model` | Change model/effort on existing thread when T3 allows |
| `set_thread_runtime` | Change runtimeMode when T3 allows |
| `rename_thread` | Rename title |
| `watch_thread` | Arm webhook for when the current/next **prompt** finishes (not each turn); optional `notifyOnAttention` |
| `unwatch_thread` | Clear watch |
| `list_watches` | Active watches |

**Success criteria for “fixed incompatible_response”:** against live menet2, `list_projects`, `list_threads`, `start_thread`, and `get_thread` return structured success (or a typed bridge error), never a host-level `incompatible_response` caused by our payload shape.

## 7. Webhook notifications

### What counts as “done”

Default is **not** “every turn” and **not** every status flicker. A watch arms against the **user prompt** that triggered work (`start_thread` / `send_message` / explicit `watch_thread`): fire **once** when that prompt’s run reaches a **terminal** outcome — the agent finished processing that prompt (success or hard stop).

Do **not** notify by default for:

- Intermediate assistant messages / streaming chunks inside the same run
- Transient statuses while still working (`working`, `connecting`, `preparing`, `queued`, `waiting`, `monitoring`)
- Attention states mid-prompt (`awaiting_approval`, `awaiting_input`, `plan_ready`) — those are **opt-in** via `watch_thread` flag `notifyOnAttention: true`

### Trigger states (default)

Fire once per watched `runId` when status enters:

- `finished`, `failed`, `interrupted`, `stopped`, `cancelled`, `rolled_back`

### Trigger states (opt-in)

Only if `notifyOnAttention: true`:

- `awaiting_approval`, `awaiting_input`, `plan_ready`

### Payload (JSON)

```json
{
  "event": "t3.run.terminal",
  "bridgeVersion": "0.1.0",
  "environmentId": "...",
  "projectId": "...",
  "threadId": "...",
  "title": "...",
  "runId": "...",
  "status": "finished",
  "summary": "optional short assistant excerpt ≤500 chars"
}
```

### Delivery

- `POST` to a Grok Bot **routine webhook** owned by T3Code.
- Header: `Authorization: Bearer <shared secret>` (or routine’s sender key mechanism as exposed by the routine panel — store secret in bridge state dir, never chat).
- Retries: 3 attempts, exponential backoff; then leave event in a local durable queue file for `list_watches` / manual replay.
- Dedupe key: `runId` for terminal fires (one notification per completed prompt run). Opt-in attention fires dedupe on `(runId, status)` so the same blocker does not spam; a new attention after resume may notify once again.

### Routine behavior (saved prompt intent)

On webhook wake: read the event; `get_thread` for context; notify Ruben in this chat that the prompt finished (or, if opt-in attention, that T3 is waiting on him). Destination: Ruben in T3Code chat. Default watches are quiet for everything except prompt completion / hard stop.

## 8. Persistence

State directory (default `~/.t3-bridge`, override `T3_BRIDGE_STATE_DIR`):

- Connect session / proof material (0600)
- Operation journal (operationId → payload, protocolVersion)
- Active watches
- Webhook URL + secret reference
- Failed delivery queue

First write uses a documented state format version; reject downgrades.

## 9. Security

- No tokens in MCP tool results or chat.
- Webhook secret required; reject unsigned POSTs at the routine edge (platform-enforced).
- Default new threads: `approval-required`.
- `full-access` only when the caller explicitly passes it (mirrors Ruben’s standing rule).

## 10. Rollout / replace t3code

1. Ship `t3-bridge` as a new MCP server config entry (suggested name `t3bridge`).
2. Verify tools live against menet2.
3. Create webhook routine; smoke `watch_thread`.
4. Point T3Code skill/memory at `t3bridge`; deprecate `user-t3code` for day-to-day once parity proven.
5. Keep sqlite fallback documented only as emergency break-glass, not the happy path.

## 11. Testing

- Unit: tolerant codecs (long IDs, extra fields, partial rows).
- Integration against fake v2 fixtures (inspired by t3code-mcp `test/fake-v2.ts`).
- Live smoke (authorized): list env/projects/threads; start a throwaway thread in `rperez`; send; watch; confirm webhook wake; interrupt.
- Regression: MCP host must accept every tool result schema we publish (fixture snapshots of outbound JSON).

## 12. Open decisions (resolved in this review cycle)

| Topic | Decision |
| --- | --- |
| Approach | B — new bridge |
| Transport | T3 Connect relay + DPoP |
| Scope | Full tool set + extras + webhook |
| Notify | Webhook → routine → wake T3Code |
| Host | Box (stdio MCP) |

## 13. Implementation next step

After Ruben approves this written spec: write an implementation plan (`writing-plans`), then implement via Cursor cloud agent in a **new** repository (Origin or GitHub as Ruben prefers at plan time).
