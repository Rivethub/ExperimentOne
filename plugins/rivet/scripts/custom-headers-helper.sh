#!/usr/bin/env bash
# Emit per-request project headers for Claude Code once `customHeadersHelper` ships
# (https://github.com/anthropics/claude-code/issues/97949). Safe to point at today:
# unsupported settings keys are ignored; when the helper lands, Rivet gets hard
# project ids on the wire without SessionStart joins.
set -euo pipefail

CWD="${CLAUDE_PROJECT_DIR:-${PWD:-}}"
if [[ -z "${CWD}" ]]; then
  exit 0
fi

# Prefer git root when available so headers match SessionStart bindings.
ROOT="$(git -C "${CWD}" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${ROOT}" ]]; then
  ROOT="${CWD}"
fi

PROJECT_ID="$(
  ROOT="$ROOT" python3 - <<'PY'
import os, re
root = os.environ.get("ROOT", "").rstrip("/\\")
if not root:
    raise SystemExit(0)
# Claude-compatible encoding: path separators → '-'
out = []
for ch in root:
    out.append("-" if ch in "/\\" else ch)
print("".join(out) or "default")
PY
)"

if [[ -z "${PROJECT_ID}" ]]; then
  exit 0
fi

printf 'X-Project-Id: %s\n' "${PROJECT_ID}"
printf 'X-Rivet-Project-Id: %s\n' "${PROJECT_ID}"
printf 'X-Rivet-Client: claude-plugin\n'
