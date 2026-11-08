#!/usr/bin/env bash
# Lint the squash merge subject GitHub will create from a PR title: "{title} (#{n})".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TITLE="${1:-}"
NUMBER="${2:-}"

if [[ -z "${TITLE}" || -z "${NUMBER}" ]]; then
  echo "usage: $0 <pr-title> <pr-number>" >&2
  exit 2
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

# Match GitHub's default squash subject when squash_merge_commit_title=PR_TITLE.
printf '%s (#%s)\n' "${TITLE}" "${NUMBER}" > "${tmpdir}/msg"
echo "Linting squash subject: $(cat "${tmpdir}/msg")"
exec bash "${ROOT}/scripts/lint-commit-msg.sh" "${tmpdir}/msg"
