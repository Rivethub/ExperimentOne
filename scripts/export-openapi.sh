#!/usr/bin/env bash
# Export Rivet control-plane OpenAPI → docs/openapi.json.
# Desktop Effect schemas in apps/desktop/src/effect/schemas.ts are hand-synced to this doc.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cargo test -p rivet-api --test export_openapi export_openapi_doc -- --ignored --nocapture

echo "wrote docs/openapi.json"
echo "tip: keep apps/desktop/src/effect/schemas.ts aligned with PublicConfig / LiveCursor / TrafficEvent"
