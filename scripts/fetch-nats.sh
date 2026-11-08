#!/usr/bin/env bash
# Download official nats-server binary for the host (or $1 triple)
# into apps/desktop/src-tauri/binaries/nats-server-$TRIPLE[.exe] for Tauri externalBin.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIPLE="${1:-$(rustc -vV | awk '/^host:/{print $2}')}"
OUT="$ROOT/apps/desktop/src-tauri/binaries"
mkdir -p "$OUT"

EXE_SUFFIX=""
case "$TRIPLE" in
  *-windows-*|*-windows) EXE_SUFFIX=".exe" ;;
esac
DEST="$OUT/nats-server-${TRIPLE}${EXE_SUFFIX}"

# Pinned NATS Server release (JetStream included).
NATS_VERSION="${NATS_VERSION:-v2.11.1}"
OS=""
ARCH=""

case "$TRIPLE" in
  aarch64-apple-darwin) OS="darwin"; ARCH="arm64" ;;
  x86_64-apple-darwin) OS="darwin"; ARCH="amd64" ;;
  aarch64-unknown-linux-gnu|aarch64-unknown-linux-musl) OS="linux"; ARCH="arm64" ;;
  x86_64-unknown-linux-gnu|x86_64-unknown-linux-musl) OS="linux"; ARCH="amd64" ;;
  x86_64-pc-windows-msvc|x86_64-pc-windows-gnu) OS="windows"; ARCH="amd64" ;;
  aarch64-pc-windows-msvc|aarch64-pc-windows-gnu) OS="windows"; ARCH="arm64" ;;
  *)
    echo "unsupported triple for bundled nats-server: $TRIPLE" >&2
    exit 1
    ;;
esac

ASSET="nats-server-${NATS_VERSION}-${OS}-${ARCH}"
if [[ "$OS" == "windows" ]]; then
  URL="https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/${ASSET}.zip"
else
  URL="https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/${ASSET}.tar.gz"
fi

if [[ -f "$DEST" && -s "$DEST" && "${FORCE_NATS_FETCH:-}" != "1" ]]; then
  echo "nats-server already present: $DEST"
  echo "Set FORCE_NATS_FETCH=1 to re-download."
  exit 0
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
echo "==> fetching nats-server ($TRIPLE)"
echo "    $URL"
ARCHIVE="$TMPDIR/nats.archive"
curl -fL --progress-bar -o "$ARCHIVE" "$URL"

if [[ "$OS" == "windows" ]]; then
  unzip -q -o "$ARCHIVE" -d "$TMPDIR"
else
  tar -xzf "$ARCHIVE" -C "$TMPDIR"
fi

BIN="$(find "$TMPDIR" -type f \( -name "nats-server" -o -name "nats-server.exe" \) | head -1 || true)"
if [[ -z "$BIN" || ! -f "$BIN" ]]; then
  echo "nats-server binary not found in archive" >&2
  exit 1
fi
chmod +x "$BIN" 2>/dev/null || true
mv -f "$BIN" "$DEST"
if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
fi
ls -lh "$DEST"
echo "OK — NATS sidecar ready (invoke as: nats-server -c …)"
