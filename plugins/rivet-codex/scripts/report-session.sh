#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export RIVET_PROVIDER="${RIVET_PROVIDER:-codex}"
exec python3 "${ROOT}/common/session_hook.py"
