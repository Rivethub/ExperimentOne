# Rivet harness plugins

Plugins that report the open project to Rivet and enable Rivet MCP history tools.

## Claude Code (`plugins/rivet`)

Bundled as marketplace `rivet` (`plugins/.claude-plugin/marketplace.json`).

On `SessionStart` / `CwdChanged`, posts `session_id` + `cwd` to
`POST /v1/harness/session`. Rivet derives a Claude-compatible `project_id` and
joins it onto live proxy traffic that carries `x-claude-code-session-id`.

Also ships `.mcp.json` pointing at the local Rivet MCP server.

Harness install copies this marketplace under Application Support and enables
`rivet@rivet` in Claude settings.

## Codex (`plugins/rivet-codex`)

Same session-binding hook for Codex lifecycle events, plus MCP registration via
Codex config when Rivet runs harness install.

## Manual enable (Claude)

```bash
# After Rivet has copied the marketplace into $RIVET_DATA_DIR/plugins
claude plugin marketplace add --source directory "$RIVET_DATA_DIR/plugins"
claude plugin install rivet@rivet --scope user
```
