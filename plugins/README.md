# Rivet harness plugins (optional)

Plugins **do not capture traffic**. Live capture is proxy-only
(`rivet-proxy` → `rivetsink` → `/v1/ingest`).

Plugins only improve what the proxy can already capture / what the agent sees
at session start:

- bind `session_id` → cwd / project so ingest can attach hard `project_id`
- clear bindings on SessionEnd
- enable Rivet MCP history tools
- **SessionStart memory inject** — budgeted `/v1/memory/startup` including
  workspace `SOUL.md` / `IDENTITY.md` / `MEMORY.md` (and `AGENTS.md`) when
  present under the project root (also `.rivet/` and `memory/` aliases)
- (Claude) forward-compatible `customHeadersHelper` that emits `X-Project-Id`
  on the wire once Claude Code ships that setting

Shared logic: `common/session_hook.py` (session bind + startup inject only).

Disable inject without uninstalling: `RIVET_STARTUP_INJECT=0`.

## Workspace identity files

Drop any of these in the project root (first match wins per title):

| File | Section |
| --- | --- |
| `SOUL.md` | Soul |
| `IDENTITY.md` | Identity |
| `MEMORY.md` | Memory |
| `AGENTS.md` | Agents |

Also checked: `.rivet/*.md`, `memory/*.md`, and lowercase names.

On SessionStart the hook POSTs cwd + file contents to Rivet, which merges them
with topic context / recent traffic / hybrid hits under a ~4k token budget, then
emits:

- Claude Code: `hookSpecificOutput.additionalContext`
- Cursor: `additional_context` (and camelCase alias)

This is **context inject only** — not harness traffic ingress.

## Claude Code (`plugins/rivet`)

Marketplace `rivet` (`.claude-plugin/marketplace.json`).

| Hook | Purpose |
| --- | --- |
| `SessionStart` | Bind session → project + startup memory inject |
| `CwdChanged` | Refresh when Claude cds |
| `UserPromptSubmit` | Heartbeat refresh each turn |
| `SessionEnd` | DELETE binding |

Also ships:

- `.mcp.json` → local Rivet MCP
- `scripts/custom-headers-helper.sh` → wired as `customHeadersHelper` for when
  Claude Code ships that setting ([#97949](https://github.com/anthropics/claude-code/issues/97949));
  today the key is ignored; when it lands, project ids ride on proxy requests

## Codex (`plugins/rivet-codex`)

| Hook | Purpose |
| --- | --- |
| `SessionStart` | Bind + startup memory inject |
| `UserPromptSubmit` | Refresh cwd each prompt |
| `SessionEnd` | DELETE binding |

Harness install also merges `[mcp_servers.rivet]` into `config.toml`.

## Cursor (`plugins/rivet-cursor`)

| Hook | Purpose |
| --- | --- |
| `sessionStart` | Bind (`workspace_roots[0]` / `CURSOR_PROJECT_DIR`) + `additional_context` inject |
| `beforeSubmitPrompt` | Refresh each prompt |
| `sessionEnd` | DELETE binding |

Install writes `~/.cursor/hooks.json` and `~/.cursor/rivet.mcp.json`.

## One-click install

Desktop Harness tab / `POST /v1/harness/write` with target `claude`, `codex`, or
`cursor` copies this tree under Application Support and enables the hooks.
Proxy routing alone is enough for capture; plugins are optional fidelity +
startup memory.
