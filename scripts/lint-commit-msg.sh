#!/usr/bin/env bash
# Require Conventional Commits with a Rivet project scope, then run committed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MSG_FILE="${1:-}"

if [[ -z "${MSG_FILE}" || ! -f "${MSG_FILE}" ]]; then
  echo "usage: $0 <commit-msg-file>" >&2
  exit 2
fi

if ! command -v committed >/dev/null 2>&1; then
  echo "committed is required (brew install committed)" >&2
  exit 1
fi

SCOPES_CSV="$(
  python3 - <<'PY' "${ROOT}/committed.toml"
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
block = re.search(r"allowed_scopes\s*=\s*\[(.*?)\]", text, re.S)
if not block:
    raise SystemExit("allowed_scopes missing from committed.toml")
print(",".join(re.findall(r'"([^"]+)"', block.group(1))))
PY
)"
IFS=',' read -r -a SCOPES <<< "${SCOPES_CSV}"

SUBJECT="$(
  python3 - <<'PY' "${MSG_FILE}"
import sys
from pathlib import Path
lines = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
for line in lines:
    if not line.startswith("#"):
        print(line)
        break
PY
)"

# Match git / hk skip patterns for generated titles.
case "${SUBJECT}" in
  "fixup! "*|"squash! "*|"amend! "*|"Merge branch "*|"Merge branches "*|"Merge tag "*|"Merge tags "*|"Merge commit "*|"Merge remote-tracking branch "*|"Merge remote-tracking branches "*|"Merge pull request "*|"Revert \""*)
    exit 0
    ;;
esac

if [[ ! "${SUBJECT}" =~ ^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(([a-z0-9-]+)\))?(!)?:\ (.+)$ ]]; then
  cat >&2 <<EOF
Commit message must use Conventional Commits with a project scope:

  type(scope): Subject

Allowed scopes: ${SCOPES_CSV//,/ }
Example: feat(desktop): Add tray quit confirmation
EOF
  exit 1
fi

SCOPE="${BASH_REMATCH[3]:-}"
if [[ -z "${SCOPE}" ]]; then
  cat >&2 <<EOF
Commit scope is required.

  type(scope): Subject

Allowed scopes: ${SCOPES_CSV//,/ }
EOF
  exit 1
fi

allowed=0
for s in "${SCOPES[@]}"; do
  if [[ "${SCOPE}" == "${s}" ]]; then
    allowed=1
    break
  fi
done
if [[ "${allowed}" -ne 1 ]]; then
  cat >&2 <<EOF
Unknown commit scope '${SCOPE}'.

Allowed scopes: ${SCOPES_CSV//,/ }
EOF
  exit 1
fi

exec committed --commit-file "${MSG_FILE}" --config "${ROOT}/committed.toml"
