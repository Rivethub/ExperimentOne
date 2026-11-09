# Rivet setup (agent drop-in)

You are setting up **Rivet**, a local-first multi-account AI proxy. Use the `rivet` CLI only — do not invent API keys, edit OAuth tokens, or commit secrets.

## 1. Install the CLI (if needed)

```bash
curl -fsSL https://raw.githubusercontent.com/wSedlacek/Rivet/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

If `rivet` is already on `PATH`, skip the curl. Override repo with `RIVET_GITHUB_REPO=owner/name` when needed.

## 2. Install runtime + start

```bash
rivet setup
```

This downloads the latest GitHub release archive for this machine, starts `rivetd`, and prints onboarding status. If releases are not published yet and you are in the Rivet repo with built sidecars, set `RIVET_BIN_DIR` to that binaries directory and run `rivet start` instead.

## 3. Sign in a provider (human required)

Pick a provider from `rivet providers` (common: `claude`, `codex`).

```bash
rivet login claude
```

**OAuth / device login must be completed by the human.** Show the full CLI output (URL or device code) to the user. Poll until done:

```bash
rivet login status --watch
```

Cancel with `rivet login cancel` if they abort. Do not invent credentials or paste secrets into chat logs.

## 4. Point the harness at Rivet

```bash
rivet harness write claude
# or: rivet harness write codex
```

Default mode overlays the user config (with backup). Use `--mode isolated` only when the user wants a Rivet-owned config dir.

## 5. Verify

```bash
rivet doctor
rivet status --json
```

Optional smoke test (sample captures, no provider call):

```bash
rivet demo seed
rivet captures recent
```

## Done when

`rivet doctor` exits 0 (`proxy_running`, `has_accounts`, `harness_ready`). Report those three flags and the proxy base URL from `rivet status`.

## Rules

- Prefer `rivet … --json` when parsing machine output.
- Control API is localhost-only; the CLI fetches `X-Rivet-Key` via `/v1/session` automatically.
- Never export or print the full access key unless the user explicitly asks.
- Stop with `rivet stop` only if the user wants Rivet shut down.
