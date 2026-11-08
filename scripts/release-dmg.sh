#!/usr/bin/env bash
# Build a Rivet DMG with optional codesign + notarize.
#
# Usage:
#   ./scripts/release-dmg.sh
#   APPLE_SIGNING_IDENTITY="Developer ID Application: …" ./scripts/release-dmg.sh
#   APPLE_ID=… TEAM_ID=… APP_SPECIFIC_PASSWORD=… ./scripts/release-dmg.sh --notarize
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NOTARIZE=0
for arg in "$@"; do
  case "$arg" in
    --notarize) NOTARIZE=1 ;;
  esac
done

./scripts/build-sidecars.sh

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  # Prefer Developer ID for distribution; fall back to first codesign identity.
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'\"' '/Developer ID Application/{print $2; exit}')"
  if [[ -z "$IDENTITY" ]]; then
    IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'\"' '/Apple Development|Developer ID/{print $2; exit}')"
  fi
fi

export TAURI_SIGNING_IDENTITY="${IDENTITY:-}"
echo "Building DMG (signing identity: ${IDENTITY:-unsigned})"

cd apps/desktop
if [[ -n "$IDENTITY" ]]; then
  bun run tauri build -- --bundles dmg --config "{\"bundle\":{\"macOS\":{\"signingIdentity\":\"$IDENTITY\"}}}"
else
  bun run tauri build -- --bundles dmg
fi

DMG="$(ls -t src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)"
if [[ -z "$DMG" ]]; then
  DMG="$(ls -t target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)"
fi
# Tauri 2 may place artifacts under apps/desktop/src-tauri/target
if [[ -z "$DMG" ]]; then
  DMG="$(find . -path '*/bundle/dmg/*.dmg' -type f 2>/dev/null | head -1 || true)"
fi

if [[ -z "$DMG" ]]; then
  echo "DMG not found after build" >&2
  exit 1
fi
echo "DMG=$DMG"

if [[ "$NOTARIZE" -eq 1 ]]; then
  if [[ -z "${APPLE_ID:-}" || -z "${TEAM_ID:-}" || -z "${APP_SPECIFIC_PASSWORD:-}" ]]; then
    echo "Notarize requires APPLE_ID, TEAM_ID, APP_SPECIFIC_PASSWORD" >&2
    exit 1
  fi
  if [[ "$IDENTITY" != Developer\ ID\ Application:* ]]; then
    echo "Warning: notarization typically requires a Developer ID Application certificate; current identity is: $IDENTITY" >&2
  fi
  xcrun notarytool submit "$DMG" \
    --apple-id "$APPLE_ID" \
    --team-id "$TEAM_ID" \
    --password "$APP_SPECIFIC_PASSWORD" \
    --wait
  xcrun stapler staple "$DMG"
  echo "Notarized and stapled: $DMG"
else
  echo "Skip notarize (pass --notarize with Apple credentials for Gatekeeper-clean distribution)."
fi
