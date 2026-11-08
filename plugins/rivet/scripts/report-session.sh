#!/usr/bin/env bash
# Report Claude Code session_id + cwd to Rivet's local control API.
set -euo pipefail

API_BASE="${RIVET_API_BASE:-http://127.0.0.1:8741}"
PAYLOAD="$(cat)"

SESSION_ID="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
print((d.get("session_id") or "").strip())')"
CWD="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
print((d.get("cwd") or "").strip())')"
SOURCE="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
print((d.get("hook_event_name") or "SessionStart").strip())')"

if [[ -z "${SESSION_ID}" ]]; then
  exit 0
fi
if [[ -z "${CWD}" ]]; then
  CWD="${CLAUDE_PROJECT_DIR:-$(pwd)}"
fi

KEY="${RIVET_KEY:-}"
if [[ -z "${KEY}" ]]; then
  KEY="$(
    curl -fsS -H 'Host: 127.0.0.1' "${API_BASE}/v1/session" \
      | python3 -c 'import json,sys; print((json.load(sys.stdin).get("api_key") or "").strip())' \
      2>/dev/null || true
  )"
fi
if [[ -z "${KEY}" ]]; then
  # Rivet not running — stay quiet so SessionStart never blocks Claude.
  exit 0
fi

BODY="$(
  SESSION_ID="$SESSION_ID" CWD="$CWD" SOURCE="$SOURCE" \
    python3 -c 'import json,os; print(json.dumps({"session_id":os.environ["SESSION_ID"],"cwd":os.environ["CWD"],"provider":"claude","source":os.environ.get("SOURCE","plugin")}))'
)"

curl -fsS \
  -H "Host: 127.0.0.1" \
  -H "Content-Type: application/json" \
  -H "X-Rivet-Key: ${KEY}" \
  -d "${BODY}" \
  "${API_BASE}/v1/harness/session" >/dev/null 2>&1 || true

exit 0
