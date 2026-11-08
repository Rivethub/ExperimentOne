# Rivet harness plugins

Plugins that report the open project to Rivet, clear bindings on session end, and
enable Rivet MCP history tools.

Shared logic lives in `common/session_hook.py` (POST/DELETE `/v1/harness/session`).

## Claude Code (`plugins/rivet`)

Marketplace `rivet` (`.claude-plugin/marketplace.json`).

| Hook | Purpose |
| --- | --- |
| `SessionStart` | Bind session → project |
| `CwdChanged` | Refresh when Claude cds |
| `UserPromptSubmit` | Heartbeat refresh each turn |
| `SessionEnd` | DELETE binding |

Also ships:

- `.mcp.json` → local Rivet MCP
- `scripts/custom-headers-helper.sh` → wired as `customHeadersHelper` for when
  Claude Code ships that setting ([#97949](https://github.com/anthropics/claude-code/issues/97949));
  today the key is ignored, and session joins still work

## Codex (`plugins/rivet-codex`)

Codex has no `CwdChanged`. Rivet uses:

| Hook | Purpose |
| --- | --- |
| `SessionStart` | Bind |
| `UserPromptSubmit` | Refresh cwd each prompt |
| `SessionEnd` | DELETE binding |

Harness install also merges `[mcp_servers.rivet]` into `config.toml`.

## Cursor (`plugins/rivet-cursor`)

Cursor plugin + user hooks install:

| Hook | Purpose |
| --- | --- |
| `sessionStart` | Bind (`workspace_roots[0]` when `cwd` absent) |
| `beforeSubmitPrompt` | Refresh each prompt |
| `sessionEnd` | DELETE binding |

Install writes `~/.cursor/hooks.json` and `~/.cursor/rivet.mcp.json`.

## One-click install

Desktop Harness tab / `POST /v1/harness/write` with target `claude`, `codex`, or
`cursor` copies this tree under Application Support and enables the hooks.
