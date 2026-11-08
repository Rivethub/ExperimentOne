#!/usr/bin/env bash
# Download the official single-file ClickHouse binary for the host (or $1 triple)
# into apps/desktop/src-tauri/binaries/clickhouse-$TRIPLE[.exe] for Tauri externalBin.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIPLE="${1:-$(rustc -vV | awk '/^host:/{print $2}')}"
OUT="$ROOT/apps/desktop/src-tauri/binaries"
mkdir -p "$OUT"

EXE_SUFFIX=""
case "$TRIPLE" in
  *-windows-*|*-windows) EXE_SUFFIX=".exe" ;;
esac
DEST="$OUT/clickhouse-${TRIPLE}${EXE_SUFFIX}"

# Pinned stable release assets (universal multi-tool binary: `clickhouse server`).
CH_VERSION="${CLICKHOUSE_VERSION:-v25.11.3.54-stable}"
URL=""
ASSET=""

case "$TRIPLE" in
  aarch64-apple-darwin)
    ASSET="clickhouse-macos-aarch64"
    ;;
  x86_64-apple-darwin)
    ASSET="clickhouse-macos"
    ;;
  aarch64-unknown-linux-gnu|aarch64-unknown-linux-musl)
    URL="https://builds.clickhouse.com/master/aarch64/clickhouse"
    ;;
  x86_64-unknown-linux-gnu|x86_64-unknown-linux-musl)
    URL="https://builds.clickhouse.com/master/amd64/clickhouse"
    ;;
  x86_64-pc-windows-msvc|x86_64-pc-windows-gnu)
    # Official Windows amd64 single binary (experimental CH Windows builds).
    URL="https://builds.clickhouse.com/master/amd64/clickhouse.exe"
    ;;
  aarch64-pc-windows-msvc|aarch64-pc-windows-gnu)
    echo "ClickHouse has no official aarch64 Windows binary yet — skipping" >&2
    exit 0
    ;;
  *)
    echo "unsupported triple for bundled ClickHouse: $TRIPLE" >&2
    exit 1
    ;;
esac

if [[ -z "$URL" ]]; then
  URL="https://github.com/ClickHouse/ClickHouse/releases/download/${CH_VERSION}/${ASSET}"
fi

if [[ -f "$DEST" && -s "$DEST" && "${FORCE_CLICKHOUSE_FETCH:-}" != "1" ]]; then
  echo "ClickHouse already present: $DEST"
  echo "Set FORCE_CLICKHOUSE_FETCH=1 to re-download."
  exit 0
fi

TMP="$(mktemp)"
echo "==> fetching ClickHouse ($TRIPLE)"
echo "    $URL"
curl -fL --progress-bar -o "$TMP" "$URL"
chmod +x "$TMP" 2>/dev/null || true
SIZE=$(wc -c <"$TMP" | tr -d ' ')
if [[ "$SIZE" -lt 1000000 ]]; then
  echo "download looks too small ($SIZE bytes) — aborting" >&2
  rm -f "$TMP"
  exit 1
fi
mv -f "$TMP" "$DEST"
if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
fi
ls -lh "$DEST"
echo "OK — ClickHouse sidecar ready (invoke as: clickhouse server)"
