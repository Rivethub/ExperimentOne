#!/usr/bin/env bash
# Build rivetd + rivet-proxy (+ optional ClickHouse) into Tauri externalBin names.
# Usage: ./scripts/build-sidecars.sh [target-triple]
# Cross-compile Go via GOOS/GOARCH when the triple differs from the host.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST_TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
TRIPLE="${1:-$HOST_TRIPLE}"
OUT="$ROOT/apps/desktop/src-tauri/binaries"
mkdir -p "$OUT"

EXE_SUFFIX=""
case "$TRIPLE" in
  *-windows-*|*-windows) EXE_SUFFIX=".exe" ;;
esac

go_env_for_triple() {
  case "$1" in
    aarch64-apple-darwin) echo "darwin arm64" ;;
    x86_64-apple-darwin) echo "darwin amd64" ;;
    aarch64-unknown-linux-gnu|aarch64-unknown-linux-musl) echo "linux arm64" ;;
    x86_64-unknown-linux-gnu|x86_64-unknown-linux-musl) echo "linux amd64" ;;
    aarch64-pc-windows-msvc|aarch64-pc-windows-gnu) echo "windows arm64" ;;
    x86_64-pc-windows-msvc|x86_64-pc-windows-gnu) echo "windows amd64" ;;
    *)
      echo "unsupported triple for Go build: $1" >&2
      return 1
      ;;
  esac
}

echo "==> building rivetd ($TRIPLE)"
if [[ "$TRIPLE" == "$HOST_TRIPLE" ]]; then
  cargo build -p rivet-runtime --release
  SRC="$ROOT/target/release/rivetd${EXE_SUFFIX}"
else
  rustup target add "$TRIPLE" >/dev/null 2>&1 || true
  cargo build -p rivet-runtime --release --target "$TRIPLE"
  SRC="$ROOT/target/$TRIPLE/release/rivetd${EXE_SUFFIX}"
fi
cp -f "$SRC" "$OUT/rivetd-${TRIPLE}${EXE_SUFFIX}"
chmod +x "$OUT/rivetd-${TRIPLE}${EXE_SUFFIX}" 2>/dev/null || true

echo "==> building rivet-proxy ($TRIPLE)"
# Prefer a Go that satisfies vendor/cliproxyapi/go.mod (proto-managed installs).
if [[ -d "${HOME}/.proto/tools/go" ]]; then
  newest_proto_go="$(ls -1d "${HOME}"/.proto/tools/go/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "${newest_proto_go}" && -x "${newest_proto_go}/go" ]]; then
    export PATH="${newest_proto_go}:${PATH}"
  fi
fi
if command -v go >/dev/null 2>&1; then
  :
elif [[ -x /usr/local/go/bin/go ]]; then
  export PATH="/usr/local/go/bin:$PATH"
elif [[ -x /usr/lib/go/bin/go ]]; then
  export PATH="/usr/lib/go/bin:$PATH"
else
  echo "go not found on PATH" >&2
  exit 1
fi
read -r GOOS GOARCH <<<"$(go_env_for_triple "$TRIPLE")"
(
  cd "$ROOT/vendor/cliproxyapi"
  CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" \
    go build -o "$OUT/rivet-proxy-${TRIPLE}${EXE_SUFFIX}" ./cmd/server
)
chmod +x "$OUT/rivet-proxy-${TRIPLE}${EXE_SUFFIX}" 2>/dev/null || true

echo "==> fetching ClickHouse ($TRIPLE)"
if ! "$ROOT/scripts/fetch-clickhouse.sh" "$TRIPLE"; then
  echo "WARN: ClickHouse fetch failed for $TRIPLE — rivetd will need RIVET_CLICKHOUSE_URL" >&2
fi

echo "==> fetching nats-server ($TRIPLE)"
if ! "$ROOT/scripts/fetch-nats.sh" "$TRIPLE"; then
  echo "WARN: nats-server fetch failed for $TRIPLE — rivetd will need RIVET_NATS_URL" >&2
fi

ls -lh "$OUT"/rivetd-"$TRIPLE"* "$OUT"/rivet-proxy-"$TRIPLE"* 2>/dev/null || true
ls -lh "$OUT"/clickhouse-"$TRIPLE"* 2>/dev/null || true
ls -lh "$OUT"/nats-server-"$TRIPLE"* 2>/dev/null || true
echo "OK — sidecars ready for tauri build ($TRIPLE)"
