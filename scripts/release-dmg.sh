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
bun install
# Tauri 2: --bundles is a tauri arg (do not pass after `--` into cargo).
# Prefer .app first — Finder AppleScript DMG layout often times out in CI/agent hosts.
BUILD_OK=0
if [[ -n "$IDENTITY" ]]; then
  bunx tauri build --bundles app --config "{\"bundle\":{\"macOS\":{\"signingIdentity\":\"$IDENTITY\"}}}" && BUILD_OK=1
else
  bunx tauri build --bundles app && BUILD_OK=1
fi

APP="$(find src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' -type d 2>/dev/null | head -1 || true)"
if [[ -z "$APP" ]]; then
  APP="$(find . -path '*/bundle/macos/*.app' -type d 2>/dev/null | head -1 || true)"
fi
if [[ -z "$APP" || "$BUILD_OK" -ne 1 ]]; then
  echo "Rivet.app not found after build" >&2
  exit 1
fi
echo "APP=$APP"

DMG_DIR="$(dirname "$APP")/../dmg"
mkdir -p "$DMG_DIR"
DMG="$DMG_DIR/Rivet_1.0.0_aarch64.dmg"
rm -f "$DMG"
# Plain UDZO — no Finder AppleScript window layout (avoids -1712 timeouts).
hdiutil create -volname Rivet -srcfolder "$APP" -ov -format UDZO "$DMG"
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
