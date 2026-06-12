# Orchestra — Codex multi-agent orchestration

> A control plane for running and supervising many Codex agents at once, without
> babysitting background terminals.

Status: **draft / design**
Target Codex: **`codex-cli 0.138.0`** (app-server **protocol v2**)
Last updated: 2026-06-08

---

## 1. Problem

Running several Codex agents today means spawning N `codex` / `codex exec`
processes, each owning a TTY, each blocking independently on approval prompts
("Allow this command? [y/n]"), each with its own scrollback. There is no single
place to see status, stream output, approve actions, interrupt, or resume.

Orchestra replaces that with **one long-lived backend process** that speaks a
structured protocol and multiplexes many conversations over a single
connection. Each agent becomes a first-class object (a *thread*) that the UI
renders as a card/tab. No terminals to track.

---

## 2. Why `codex app-server` (and why v2)

### 2.1 What app-server is

`codex app-server` is the headless backend the official Codex GUIs / IDE
integrations are built on. Instead of scraping a TUI, a client opens a
**JSON-RPC 2.0** connection and drives the full session lifecycle
programmatically. It manages many conversations concurrently in one process.

Contrast with the wrong layers:

| Surface              | What it's for                                   | Use here? |
| -------------------- | ----------------------------------------------- | --------- |
| `codex` (TUI)        | Interactive human use                           | No        |
| `codex exec`         | One-shot non-interactive run                    | No        |
| `codex mcp-server`   | Expose Codex *as a tool* to another agent (MCP) | No        |
| **`codex app-server`** | **Full session lifecycle over JSON-RPC**      | **Yes**   |

### 2.2 v1 vs v2 — decision: **v2**

Verified against the 0.138.0 source (`app-server-protocol/src/protocol/`):

- The live `ClientRequest` enum (`protocol/common.rs`) references **305 distinct
  `v2::` types vs 15 `v1::` types**.
- Only `initialize` and a couple of legacy methods (e.g. `InterruptConversation`)
  are v1. **Every real method** — `thread/start`, `turn/start`, `thread/list`,
  `thread/resume`, `item/*`, `account/*`, `config/*`, `command/exec/*` — is
  `v2::*Params`.
- v1 is vestigial. v2 is the protocol.

### 2.3 Stability of v2 (justifies pinning + thin abstraction)

Diffed `rust-v0.138.0` → `origin/main` (many releases ahead, up to PR #27106):

- **The wire method table did not change at all** — zero methods added, removed,
  or renamed.
- The only v2 field deltas are backward-compatible:
  - one added **optional** `thread_id`,
  - one serde rename that keeps **both** names as aliases
    (`auto_review` ⇄ `guardian_subagent`),
  - a doc-comment edit.
- `rust-v0.139.0-alpha.1` shows the identical (tiny) churn.

Conclusion: v2 is safe to build on. Pin to 0.138.0, wrap behind an interface
(§6) so a future version bump is a near-no-op.

> Note: some v2 methods are gated `#[experimental(...)]` (e.g. `thread/search`,
> `thread/settings/update`, `thread/backgroundTerminals/clean`). The core methods
> Orchestra needs are **not** experimental. Treat experimental methods as
> optional capabilities, feature-detected at runtime.

---

## 3. Domain model

```
Thread  = one agent / conversation
  id, cwd, model, status, name, goal, tokenUsage
  └─ Turn   = one request -> response cycle
       id (turnId), status, diff, plan
       └─ Item = a unit inside a turn
            agent message | reasoning | command execution | file change | mcp tool call
```

This maps 1:1 onto the UI: **one card = one Thread**. Running N agents = calling
`thread/start` N times on the same connection and routing notifications by
`threadId`.

---

## 4. Protocol surface (the subset Orchestra uses)

### 4.1 Client → server requests

| Method                  | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| `initialize`            | Handshake (once). Then send `initialized` notif.     |
| `thread/start`          | Spawn an agent. `cwd`, `model`, `sandbox`, `approvalPolicy`, `personality`. → `threadId` |
| `turn/start`            | Give an agent a task. `threadId` + `input[]`. → `turnId` |
| `turn/steer`            | Inject guidance into a running turn (`expectedTurnId` precondition) |
| `turn/interrupt`        | Stop a running turn (`threadId` + `turnId`)          |
| `thread/list`           | List sessions. Filters: `cwd`, `archived`, `searchTerm`; paginated |
| `thread/read`           | Load full transcript for a thread                    |
| `thread/resume`         | Reattach to / rejoin a thread (prefer by `threadId`) |
| `thread/fork`           | Branch a thread                                       |
| `thread/name/set`       | Rename (card title)                                  |
| `thread/goal/set`       | Set a persistent goal                                |
| `thread/archive` / `unarchive` | Lifecycle                                     |
| `thread/compact/start`  | Compact context                                      |
| `model/list`            | Available models                                     |
| `account/rateLimits/read`, `account/usage/read` | Quota / usage for the UI     |
| `review/start`          | Kick a code review                                   |

### 4.2 Server → client notifications (the live feed; all carry `threadId`)

| Notification                          | Drives in UI                       |
| ------------------------------------- | ---------------------------------- |
| `thread/started`                      | Card created                       |
| `thread/status/changed`              | Status badge (idle/running/waiting)|
| `turn/started`, `turn/completed`      | Turn lifecycle; **capture `turnId`** |
| `turn/diff/updated`                   | Live diff view                     |
| `turn/plan/updated`, `item/plan/delta`| Plan / todo panel                  |
| `item/started`, `item/completed`      | Transcript items                   |
| `item/agentMessage/delta`             | Streaming assistant tokens         |
| `item/reasoning/textDelta`            | Streaming reasoning                |
| `item/commandExecution/outputDelta`   | Live command output                |
| `thread/tokenUsage/updated`           | Token meter per card               |
| `account/rateLimits/updated`          | Global quota indicator             |
| `error`, `warning`                    | Toasts / error state               |

### 4.3 Server → client **requests** (approvals — the key UX win)

When an agent wants to act, the server sends *Orchestra* a request and blocks
until answered. Multiplex these into a **single approvals inbox** instead of N
blocked terminals.

| Server request                          | Reply with                  |
| --------------------------------------- | --------------------------- |
| `item/commandExecution/requestApproval` | approve / deny              |
| `item/fileChange/requestApproval`       | approve / deny              |
| `item/tool/requestUserInput`            | user input                  |
| `mcpServer/elicitation/request`         | elicited values             |

Alternative: set `approvalPolicy: "never"` + a per-thread `sandbox` to auto-run
without prompts (good for trusted/isolated agents).

---

## 5. Transport & process model

`--listen` supports `stdio://` (default), `unix://PATH`, `ws://IP:PORT`, `off`.

Two modes:

1. **Plain stdio** — `codex app-server --stdio`. Orchestra spawns it as a child,
   writes JSON-RPC to stdin, reads newline-delimited messages from stdout.
   Simple, but agents die when Orchestra exits.

2. **Daemon + remote-control (chosen default)**
   ```
   codex app-server daemon start
   codex app-server daemon enable-remote-control
   # clients attach via:
   codex app-server proxy            # stdio <-> daemon control socket
   # or listen on a socket the UI connects to directly:
   codex app-server --listen unix:///tmp/orchestra.sock
   ```
   **Agents survive UI restarts/crashes.** On reconnect, repopulate cards via
   `thread/list` (+ `thread/resume` for active ones). This is the core of "no
   background terminals."

---

## 6. Replaceability — the abstraction boundary

Goal: nothing above the transport layer imports generated Codex types directly,
so we can bump Codex versions or even swap backends with localized changes.

```
┌─────────────────────────────────────────────┐
│ UI (cards, approvals inbox, diff/plan views) │
├─────────────────────────────────────────────┤
│ AgentManager  — domain model, keyed by id    │  <- our types only
│   startAgent(cwd, opts) / send(id, input)    │
│   interrupt(id) / steer(id, input)           │
│   on(event) -> {AgentEvent}                   │
├─────────────────────────────────────────────┤
│ CodexBackend (interface)                      │  <- maps domain <-> wire
│   request(method, params) / notifications$    │
│   serverRequests$ (approvals)                 │
├─────────────────────────────────────────────┤
│ CodexV2Transport  — JSON-RPC over socket      │  <- ONLY layer that knows v2
│   uses bindings/codex-v2/*                     │
└─────────────────────────────────────────────┘
```

Rules:
- `bindings/codex-v2/` (generated TS) is imported **only** by `CodexV2Transport`.
- `AgentManager` exposes Orchestra's own `Agent` / `AgentEvent` / `Approval`
  types. A future `CodexV3Transport` (or a non-Codex backend) implements the
  same `CodexBackend` interface; nothing else changes.
- Regenerate bindings per Codex version:
  `codex app-server generate-ts --out bindings/codex-vNNN`. Diff against the
  pinned set before adopting.

### 6.1 Client-side state (keyed by `threadId`)

```ts
type AgentCard = {
  threadId: string;
  name: string;            // thread/name/set
  cwd: string;
  status: ThreadStatus;    // thread/status/changed
  activeTurnId?: string;   // from turn/started — REQUIRED for interrupt/steer
  transcript: Item[];      // appended from item/* notifications
  pendingApprovals: Approval[]; // rendered as buttons
  tokenUsage: number;      // thread/tokenUsage/updated
};
```

### 6.2 Minimal lifecycle (wire sketch)

```jsonc
-> {"id":1,"method":"initialize","params":{"clientInfo":{...}}}
-> {"method":"initialized"}                                  // notification
-> {"id":2,"method":"thread/start","params":{"cwd":"/repo","model":"gpt-5.3-codex","sandbox":"workspace-write","approvalPolicy":"on-request"}}
<- {"id":2,"result":{"threadId":"th_abc"}}
-> {"id":3,"method":"turn/start","params":{"threadId":"th_abc","input":[{"type":"text","text":"refactor X"}]}}
<- {"method":"turn/started","params":{"threadId":"th_abc","turnId":"tn_1"}}
<- {"method":"item/agentMessage/delta","params":{"threadId":"th_abc", ...}}
<- {"id":99,"method":"item/commandExecution/requestApproval","params":{...}}
-> {"id":99,"result":{"decision":"approved"}}
<- {"method":"turn/completed","params":{"threadId":"th_abc","turnId":"tn_1"}}
```

---

## 7. Concurrency & isolation

Agents that write files **must not share a working tree**. Options per thread:

- distinct `cwd` per agent (e.g. one git worktree each), or
- `sandbox: "read-only"` for explorer/analysis agents, or
- `sandbox: "workspace-write"` scoped to that agent's `cwd`.

`turn/start` can override `cwd` / `sandbox` / `model` / `effort` per turn, so an
agent can be re-pointed without restart.

---

## 8. Versioning / pinning strategy

- Pin runtime to `codex-cli 0.138.0`; pin source to tag `rust-v0.138.0`.
- Commit `bindings/codex-v2/` (generated from 0.138.0) to the repo as the
  source of truth for wire types.
- On Codex upgrade: generate into a new `bindings/codex-vNNN`, diff the
  `ClientRequest` / `ServerNotification` / `ServerRequest` unions, update
  `CodexV2Transport` only if the table changed (it hasn't through current main).
- Feature-detect `#[experimental]` methods at runtime; never hard-depend on them.

---

## 9. Open questions / decisions to make

- **UI stack**: web (connect to `ws://` directly) vs Electron vs TUI?
  Determines whether we use `--listen ws://` or spawn+proxy over stdio.
- **Auth**: app-server uses the host's Codex login (`codex login`). Confirm the
  daemon inherits it; surface `account/rateLimits` in the UI.
- **Persistence of Orchestra's own metadata** (card layout, custom names,
  groupings) — separate store, keyed by `threadId`.
- **Approval policy default**: prompt-per-action vs sandboxed auto-run, possibly
  per-agent.
- **Multi-repo / worktree management**: does Orchestra create worktrees, or
  point agents at existing dirs?

---

## 10. CLI / tool surface (v0 — bare minimum)

Orchestra v0 ships as a **CLI** (and a thin MCP wrapper later). The philosophy:
give the orchestrator the primitives to spawn, drive, observe, and tear down
agents — it figures out fan-out, judging, and apply on its own. No `fanout`,
`judge`, or `apply` verbs in core.

### 10.1 Commands

```
register  <dir>                          pin repo + base commit (one-time)
create    <name> <dir> [-n N] [--prompt T | --prompt-file F]
                                         reflink + branch + thread + optional first turn → prints id(s)
teardown  <dir>                          stop threads + rm copies
ls                                       id, status, repo, branch
diff      <id> [--out FILE]              git diff of agent workdir (inline; --out for huge)
exec      <id> "<cmd>"                   run shell cmd in agent cwd (tests, git, etc.)
steer     <id> "<msg>"                   start-or-steer (auto-dispatch from status)
interrupt <id>                           stop current turn
turn      <id>                           current turn status + output so far
read      <id> [--json]                  write transcript to /tmp, print path
tail      <id>                           stream live deltas until turn done
```

There is **no `send`** — `create --prompt` fires the first turn; everything after
is `steer`.

### 10.2 register vs create

- **`register <dir>`** — records the source repo and **pins the base commit**
  (current default-branch tip). Guarantees all agents — created now or later —
  fork from the *same* base, which is what makes fan-in coherent. Idempotent.
  `create` auto-registers if skipped.
- **`create <name> <dir>`** — the primitive. Reflink-copies the repo, branches off the
  pinned base, starts an idle thread, optionally fires the first turn, mints a
  **4-hex agent id**, returns the id(s). The orchestrator never needs the
  workdir (derivable + stored).

### 10.3 create semantics (per-prompt; heterogeneity is free)

```
create "auth" <dir> --prompt "task"       → 1 agent, that prompt           → 1 id
create "auth" <dir> --prompt-file plan.md → 1 agent, prompt from file      → 1 id
create "auth" <dir> -n 8 --prompt "task"  → 8 agents, SAME prompt (fan-out)→ 8 ids
```

- `n` defaults to 1. `-n N` is purely **same-prompt replication**.
- **Different prompts = multiple `create` calls**, each returning its id(s). No
  batch-heterogeneous syntax needed; the orchestrator loops.
- `--prompt` and `--prompt-file` are mutually exclusive (file avoids
  shell-quoting pain and records what each agent was told).

### 10.4 Creation flow

```
register ~/proj
  → repos row: path=~/proj, base_commit=<tip>, base_branch=main

create ~/proj -n 32 --prompt "..."
  for each of 32:
    cp --reflink=auto -r ~/proj ~/.orchestra/runs/proj/<id>/      # instant CoW, ~0 disk
    git -C <copy> switch -c orchestra/<id> <base_commit>          # branch off pinned base
    thread/start { cwd: <copy> }  → threadId                       # idle thread
    if prompt: turn/start { input: prompt }                        # first turn
    insert agent row
  → prints 32 ids
```

### 10.5 steer = smart dispatch

`turn/steer` only applies to a *running* turn; once idle, more input is a new
`turn/start`. The orchestrator shouldn't track this — `steer` dispatches:

```
steer <id> "<msg>":
  if agent.status == running → turn/steer  (uses tracked active_turn_id)
  else                       → turn/start  (new turn)
```

### 10.6 read → temp file (never dump transcripts inline)

`read <id>` writes a markdown transcript to `/tmp/orchestra/<id>-<turncount>.md`
and prints **only the path**; `--json` for a structured dump. The orchestrator
greps/reads selectively, keeping full histories out of its context window.

### 10.7 Workspaces — reflink, not symlink-commons

Host FS for `~/.orchestra` is **XFS with reflink** (verified). Use
`cp --reflink=auto -r` for instant, near-zero-disk, **fully write-isolated**
copies. Do **not** use the symlink-shared-commons approach — it corrupts
siblings on write. (Fallback only on non-CoW FS: symlink read-only artifacts
mounted read-only; relocate git-tracked multi-GB weights out of git first.)

Copies live in `~/.orchestra/runs/<dirname>/<id>/` — **outside** the source repo
(avoids git recursion / accidental commits).

### 10.8 Git strategy — branch off pinned base, keep history

Each copy keeps its `.git` (comes along via reflink — cheap) and checks out
`orchestra/<id>` at the pinned base commit. Agents commit freely (periodic
auto-commit = checkpointing). Fan-in is plain git against the base:
`git diff <base>..orchestra/<id>`, cherry-pick, 3-way merge, or `format-patch`.
**Never re-init** — that throws away the base and reduces fan-in to file diffing.

### 10.9 Persistence — SQLite (`~/.orchestra/orchestra.db`)

```sql
CREATE TABLE repos (
  id          INTEGER PRIMARY KEY,
  path        TEXT UNIQUE NOT NULL,      -- ~/proj
  base_commit TEXT NOT NULL,             -- pinned at register
  base_branch TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE agents (
  id             TEXT PRIMARY KEY,       -- 4-hex handle, e.g. 'a3f1'
  repo_id        INTEGER NOT NULL REFERENCES repos(id),
  cwd            TEXT NOT NULL,          -- ~/.orchestra/runs/proj/a3f1
  branch         TEXT NOT NULL,          -- orchestra/a3f1
  thread_id      TEXT NOT NULL,          -- app-server threadId (internal)
  active_turn_id TEXT,                   -- tracked from turn/started → steer/interrupt
  status         TEXT NOT NULL,          -- idle | running | waiting_approval | error
  created_at     INTEGER NOT NULL
);
```

`status` / `active_turn_id` are updated by a listener on the daemon's
notification stream (`thread/status/changed`, `turn/started`, `turn/completed`).
Read-path commands (`ls`) hit SQLite only — no daemon round-trip.

### 10.10 Module layout

1. **workspace** — reflink copy + branch + SQLite (pure fs/git; no daemon).
2. **transport** — v2 app-server client (`bindings/codex-v2/` used here only).
3. **orchestrator** — wires commands to workspace + transport; runs the
   notification listener.

Adapters (CLI now, MCP/HTTP later) are thin shims over the orchestrator. MCP
tools must be **async** (return ids, poll via `ls`/`turn`/`read`) — a 32-agent
fan-out can't block one tool call.

---

## 11. Artifacts in this folder

- `spec.md` — this document.
- `bindings/codex-v2/` — TypeScript protocol bindings generated from
  `codex-cli 0.138.0` (`generate-ts`). `ClientRequest.ts`,
  `ServerNotification.ts`, `ServerRequest.ts`, `ClientNotification.ts` at top
  level; payload types under `v2/`. **Imported only by the transport layer.**
