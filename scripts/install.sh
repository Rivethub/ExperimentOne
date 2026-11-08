#!/usr/bin/env bash
# Bootstrap the Rivet CLI from the latest GitHub release (headless archive).
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wSedlacek/Rivet/main/scripts/install.sh | bash
# Env:
#   RIVET_GITHUB_REPO  owner/name (default: wSedlacek/Rivet)
#   RIVET_VERSION      release tag (default: latest)
#   RIVET_INSTALL_DIR  install root (default: ~/.local/share/rivet/install)
#   GITHUB_TOKEN       optional — raises API rate limits / private releases
set -euo pipefail

REPO="${RIVET_GITHUB_REPO:-wSedlacek/Rivet}"
VERSION="${RIVET_VERSION:-}"
USER_BIN="${RIVET_USER_BIN:-${HOME}/.local/bin}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "${os}-${arch}" in
  darwin-arm64|darwin-aarch64) TRIPLE="aarch64-apple-darwin" ;;
  darwin-x86_64) TRIPLE="x86_64-apple-darwin" ;;
  linux-x86_64|linux-amd64) TRIPLE="x86_64-unknown-linux-gnu" ;;
  linux-aarch64|linux-arm64) TRIPLE="aarch64-unknown-linux-gnu" ;;
  mingw*|msys*|cygwin*)
    echo "Windows: download the .zip release asset for your triple, or build with cargo." >&2
    exit 1
    ;;
  *)
    echo "unsupported platform: os=${os} arch=${arch}" >&2
    exit 1
    ;;
esac

if [[ -n "${RIVET_INSTALL_DIR:-}" ]]; then
  INSTALL_ROOT="${RIVET_INSTALL_DIR}"
elif [[ -n "${XDG_DATA_HOME:-}" ]]; then
  INSTALL_ROOT="${XDG_DATA_HOME}/rivet/install"
else
  INSTALL_ROOT="${HOME}/.local/share/rivet/install"
fi
BIN_DIR="${INSTALL_ROOT}/bin"
mkdir -p "${BIN_DIR}" "${USER_BIN}"

AUTH_HEADER=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

api="https://api.github.com/repos/${REPO}/releases"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

fetch_release_json() {
  local url="$1"
  curl -fsSL "${AUTH_HEADER[@]}" \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: rivet-install" \
    "$url" -o "${tmp}/release.json"
}

if [[ -n "${VERSION}" ]]; then
  tag_raw="${VERSION}"
  if ! fetch_release_json "${api}/tags/${tag_raw}"; then
    fetch_release_json "${api}/tags/v${VERSION#v}"
  fi
else
  fetch_release_json "${api}/latest"
fi

tag_name="$(
  sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' "${tmp}/release.json" | head -1
)"
if [[ -z "${tag_name}" ]]; then
  echo "could not parse release tag from GitHub API response" >&2
  exit 1
fi
ver="${tag_name#v}"

asset_name=""
for candidate in \
  "rivet-${ver}-${TRIPLE}.tar.gz" \
  "rivet-${ver}-${TRIPLE}.tgz" \
  "rivet-${TRIPLE}.tar.gz" \
  "rivet-${TRIPLE}.tgz"
do
  if grep -q "\"name\":[[:space:]]*\"${candidate}\"" "${tmp}/release.json"; then
    asset_name="${candidate}"
    break
  fi
done

if [[ -z "${asset_name}" ]]; then
  echo "No headless archive for ${TRIPLE} in ${REPO}@${tag_name}." >&2
  echo "Expected asset like rivet-${ver}-${TRIPLE}.tar.gz (release publishing comes later)." >&2
  echo "Assets:" >&2
  grep -o '"name":[[:space:]]*"[^"]*"' "${tmp}/release.json" | head -40 >&2 || true
  exit 1
fi

download_url="https://github.com/${REPO}/releases/download/${tag_name}/${asset_name}"
echo "Downloading ${asset_name} from ${REPO}@${tag_name}…"
curl -fsSL "${AUTH_HEADER[@]}" \
  -H "User-Agent: rivet-install" \
  -L \
  -o "${tmp}/rivet.tgz" \
  "${download_url}"

mkdir -p "${tmp}/extract"
tar -xzf "${tmp}/rivet.tgz" -C "${tmp}/extract"

# Normalize into BIN_DIR (flat or nested layouts, plus triple-suffixed names).
while IFS= read -r -d '' f; do
  base="$(basename "$f")"
  case "$base" in
    rivet|rivet-"${TRIPLE}") out="rivet" ;;
    rivetd|rivetd-"${TRIPLE}") out="rivetd" ;;
    rivet-proxy|rivet-proxy-"${TRIPLE}") out="rivet-proxy" ;;
    clickhouse|clickhouse-"${TRIPLE}") out="clickhouse" ;;
    *) continue ;;
  esac
  install -m 755 "$f" "${BIN_DIR}/${out}"
done < <(find "${tmp}/extract" -type f \( \
    -name 'rivet' -o -name 'rivetd' -o -name 'rivet-proxy' -o -name 'clickhouse' \
    -o -name "rivet-${TRIPLE}" -o -name "rivetd-${TRIPLE}" \
    -o -name "rivet-proxy-${TRIPLE}" -o -name "clickhouse-${TRIPLE}" \
  \) -print0)

echo "${tag_name}" > "${INSTALL_ROOT}/VERSION"

if [[ -x "${BIN_DIR}/rivet" ]]; then
  ln -sfn "${BIN_DIR}/rivet" "${USER_BIN}/rivet"
  echo "Installed Rivet CLI → ${USER_BIN}/rivet"
else
  echo "warning: archive had no rivet binary; rivetd may still be present under ${BIN_DIR}" >&2
fi

echo "Install root: ${INSTALL_ROOT}"
echo "Next: ensure ${USER_BIN} is on PATH, then run: rivet setup"
