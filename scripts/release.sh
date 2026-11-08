#!/usr/bin/env bash
# Build Rivet desktop installers for the host OS (or $1 = macos|linux|windows).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET_OS="${1:-}"
if [[ -z "$TARGET_OS" ]]; then
  case "$(uname -s)" in
    Darwin) TARGET_OS=macos ;;
    Linux) TARGET_OS=linux ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) TARGET_OS=windows ;;
    *) echo "unknown host OS; pass macos|linux|windows" >&2; exit 1 ;;
  esac
fi

TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
./scripts/build-sidecars.sh "$TRIPLE"

cd "$ROOT/apps/desktop"
bun install
bun run build

case "$TARGET_OS" in
  macos)
    bunx tauri build --bundles dmg,app
    echo "Artifacts under apps/desktop/src-tauri/target/release/bundle/"
    ;;
  linux)
    bunx tauri build --bundles deb,appimage
    echo "Artifacts under apps/desktop/src-tauri/target/release/bundle/"
    ;;
  windows)
    bunx tauri build --bundles nsis
    echo "Artifacts under apps/desktop/src-tauri/target/release/bundle/"
    ;;
  *)
    echo "usage: $0 [macos|linux|windows]" >&2
    exit 1
    ;;
esac
