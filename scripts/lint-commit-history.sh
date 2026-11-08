#!/usr/bin/env bash
# Lint Conventional Commit messages for a revision range (CI / local).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RANGE="${1:-}"

if [[ -z "${RANGE}" ]]; then
  if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
    git fetch --no-tags --depth=1 origin "${GITHUB_BASE_REF}"
    RANGE="origin/${GITHUB_BASE_REF}..HEAD"
  else
    RANGE="HEAD"
  fi
fi

if ! command -v committed >/dev/null 2>&1; then
  echo "committed is required (brew install committed)" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

failed=0
while IFS= read -r sha; do
  [[ -z "${sha}" ]] && continue
  git log -1 --format='%B' "${sha}" > "${tmpdir}/msg"
  if ! bash "${ROOT}/scripts/lint-commit-msg.sh" "${tmpdir}/msg"; then
    echo "FAIL ${sha} $(git log -1 --format='%s' "${sha}")" >&2
    failed=1
  fi
done < <(git rev-list --no-merges "${RANGE}")

if [[ "${failed}" -ne 0 ]]; then
  exit 1
fi

echo "Commit messages OK (${RANGE})"
