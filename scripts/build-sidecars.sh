#!/usr/bin/env bash
# Build rivetd + rivet-proxy (+ optional ClickHouse) into Tauri externalBin names.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TRIPLE="${1:-$(rustc -vV | awk '/^host:/{print $2}')}"
OUT="$ROOT/apps/desktop/src-tauri/binaries"
mkdir -p "$OUT"

echo "==> building rivetd ($TRIPLE)"
cargo build -p rivet-runtime --release
cp -f "$ROOT/target/release/rivetd" "$OUT/rivetd-$TRIPLE"
chmod +x "$OUT/rivetd-$TRIPLE"

echo "==> building rivet-proxy ($TRIPLE)"
if [[ -x /usr/local/go/bin/go ]]; then
  export PATH="/usr/local/go/bin:$PATH"
fi
(
  cd "$ROOT/vendor/cliproxyapi"
  go build -o "$OUT/rivet-proxy-$TRIPLE" ./cmd/server
)
chmod +x "$OUT/rivet-proxy-$TRIPLE"
cp -f "$OUT/rivet-proxy-$TRIPLE" /tmp/rivet-proxy 2>/dev/null || true

echo "==> fetching ClickHouse ($TRIPLE)"
"$ROOT/scripts/fetch-clickhouse.sh" "$TRIPLE"
# Convenience symlink for local rivetd discovery
ln -sfn "$OUT/clickhouse-$TRIPLE" /tmp/rivet-clickhouse 2>/dev/null || \
  cp -f "$OUT/clickhouse-$TRIPLE" /tmp/rivet-clickhouse

ls -lh "$OUT"/rivetd-"$TRIPLE" "$OUT"/rivet-proxy-"$TRIPLE" "$OUT"/clickhouse-"$TRIPLE"
echo "OK — sidecars ready for tauri build"
