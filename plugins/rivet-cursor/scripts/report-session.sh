#!/usr/bin/env bash
set -euo pipefail
# Cursor plugin hooks run with cwd = plugin install dir.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export RIVET_PROVIDER="${RIVET_PROVIDER:-cursor}"
export CURSOR_PLUGIN_ROOT="${CURSOR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
exec python3 "${ROOT}/common/session_hook.py"
