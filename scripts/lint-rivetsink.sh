#!/usr/bin/env bash
# Lint Rivet sink Go code (vendor/cliproxyapi/internal/rivetsink).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CPA="$ROOT/vendor/cliproxyapi"

if [[ -d "${HOME}/.proto/tools/go" ]]; then
  newest_proto_go="$(ls -1d "${HOME}"/.proto/tools/go/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "${newest_proto_go}" && -x "${newest_proto_go}/go" ]]; then
    export PATH="${newest_proto_go}:${PATH}"
  fi
fi

if ! command -v golangci-lint >/dev/null 2>&1; then
  echo "golangci-lint not found; install via: brew install golangci-lint" >&2
  exit 1
fi

cd "$CPA"
files="$(gofmt -l ./internal/rivetsink/)"
if [[ -n "$files" ]]; then
  echo "gofmt needed on:" >&2
  echo "$files" >&2
  exit 1
fi

golangci-lint run --config .golangci.yml ./internal/rivetsink/...
go test ./internal/rivetsink/ -count=1 -vet=all
echo "OK — rivetsink lint + vet + tests"
