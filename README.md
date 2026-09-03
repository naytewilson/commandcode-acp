# commandcode-acp

Thin ACP v1 stdio bridge for the Command Code CLI. Shared integration
boundary so Paseo and T3 Code reuse one Command Code harness instead of
two independent protocol parsers:

```
Paseo   ────> commandcode-acp ──> cmd -p --output-format json
T3 Code ────/
```

Node.js >= 22 only. No Python.

## Run

```sh
npm install
npm run build
node dist/src/index.js            # serve ACP on stdio
node dist/src/index.js --version  # bridge + cmd versions
node dist/src/index.js --probe    # JSON readiness probe (no credentials printed)
COMMANDCODE_BIN=/path/to/cmd node dist/src/index.js
BRIDGE_LOG=debug node dist/src/index.js
```

## ACP surface (truthful, minimal)

- `initialize` → `{ protocolVersion: 1, agentCapabilities: { loadSession: true,
  promptCapabilities: { image: false, audio: false, embeddedContext: false } } }`
- `session/new` → fresh ACP id, no cmd process yet. Response carries
  `modes` (default/plan/auto-accept) and a `model` select config option
  built from **real `cmd --list-models` discovery** (exact ids, no hard codes).
  Empty catalog → option omitted; use client-side `models` override instead.
- `session/prompt` → exactly one `cmd -p <text> --output-format json`
  (+ `--resume`, `--model`, `--effort`, mode flag). Streams
  `agent_message_chunk` / `agent_thought_chunk` / `tool_call` /
  `tool_call_update` notifications. Returns `end_turn`, `max_turn_requests`,
  or `cancelled`.
- `session/cancel` → SIGTERM the owned child, 5 s bound, then SIGKILL.
  Exit 130 is reported as `cancelled`, never as failure.
- `session/load` → rebind a known ACP id, or bind an **explicit cmd
  transcript id** to a fresh ACP id (how T3 resumes across processes).
- `session/set_mode` → `default` | `plan` | `auto-accept` (anything else rejected).
- `session/set_config_option` → `model` (exact cmd id), `effort` (passthrough).

## Session contract

One ACP id ↔ at most one cmd transcript id ↔ cwd/model/effort/mode ↔
at most one child process. No global "latest session". Two threads in one
repo get different ACP ids and can never resume each other. Nothing is
persisted to disk; resume state lives in the client's thread binding
(T3 `resumeCursor`, Paseo session row) plus cmd's own transcript store.

## Permission contract

| ACP mode     | cmd flags        | meaning |
|--------------|------------------|---------|
| `default`    | (none)           | Fail-closed headless defaults: reads allowed; writes/shell denied unless project rules allow. |
| `plan`       | `--plan`         | Read-only exploration. |
| `auto-accept`| `--auto-accept`  | Accept edits automatically. |

There is **no yolo mode**: `--yolo` is never added silently. `cmd -p`
exposes no approval request/response channel (live evidence: denied tools
emit terminal `tool_hook_blocked`, never an approval request), so no
interactive approval bridging is implemented.

## Exit-code mapping (faithful)

0 success · 1 general · 3 auth · 4 permission · 5 rate-limit · 6 network ·
7 upstream · 8 max-turns→`max_turn_requests` · 9 no-response ·
10 insufficient-credits · 130 interrupted→`cancelled`. Anything else
(including "no final result line") fails closed as `commandcode:<class>`.

## Taste

The bridge never disables Taste: every turn spawns `cmd` in the session
cwd with the caller's HOME/env, so project + global Taste resolve exactly
as the direct CLI. Sync Taste between Neo and Dell with Command Code's own
mechanisms (`cmd taste pull/push`, global `~/.commandcode/taste`), never by
copying `auth.json` or API keys between machines.

## Auth

`cmd` owns credentials (`~/.commandcode/auth.json` or
`COMMAND_CODE_API_KEY`, which takes precedence). The bridge passes the
environment through, never logs it, and classifies auth failures (exit 3)
instead of masking them.

## T3 Code Integration

T3 Code integrates Command Code natively through its provider driver registry
(branch `forge/commandcode-acp-provider`):

- **Driver:** `CommandCodeDriver` in `apps/server/src/provider/Drivers/CommandCodeDriver.ts`
- **Settings:** `CommandCodeSettings` with optional `binaryPath` override
- **Modes:** Maps T3 interaction modes (`plan` -> `plan`, `full-access`/`auto-accept-edits` -> `auto-accept`, standard -> `default`)
- **Models:** Real model discovery via `cmd --list-models` (e.g. `poolside/laguna-s-2.1-free`, `moonshotai/kimi-k2.5`, `meta/muse-spark-1.3-contributor`)
- **Resume:** Preserves exact `cmdSessionId` cursor across process restarts

## Paseo Integration (Dual Host: NEO & DELL)

Paseo consumes `commandcode-acp` as a custom ACP provider (`extends: "acp"`).

### NEO Configuration (`~/.paseo/config.json`)

```json
{
  "agents": {
    "providers": {
      "commandcode": {
        "extends": "acp",
        "label": "Command Code",
        "description": "Command Code CLI via the commandcode-acp stdio bridge (cmd -p --output-format json).",
        "command": [
          "/Users/nayte/.nvm/versions/node/v22.23.1/bin/node",
          "/Users/nayte/Projects/commandcode-acp/dist/src/index.js"
        ],
        "env": {
          "COMMANDCODE_BIN": "/Users/nayte/.nvm/versions/node/v22.23.1/bin/cmd"
        },
        "enabled": true
      }
    }
  }
}
```

### DELL Configuration (`/home/nayte/.paseo/config.json` on `anvil-node-02`)

```json
{
  "agents": {
    "providers": {
      "commandcode": {
        "extends": "acp",
        "label": "Command Code",
        "description": "Command Code CLI via the commandcode-acp stdio bridge (cmd -p --output-format json).",
        "command": [
          "/usr/bin/node",
          "/home/nayte/commandcode-acp/dist/src/index.js"
        ],
        "env": {
          "COMMANDCODE_BIN": "/usr/local/bin/cmd"
        },
        "enabled": true
      }
    }
  }
}
```

## Acceptance Verification

```sh
# Run full bridge unit + fixture test suite (47 tests):
npm test

# Verify ACP handshake and model discovery directly over stdio:
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | node dist/src/index.js
```

