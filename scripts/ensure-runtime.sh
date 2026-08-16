#!/bin/bash
set -euo pipefail
umask 077

# Prostar owns its runtime instead of changing the user's package-manager or
# system installation. Versions and hashes are intentionally pinned so every install
# is reproducible and a replaced download fails closed.
NODE_VERSION="24.19.0"
CLOUDFLARED_VERSION="2026.8.2"
APP_ROOT="${PROSTAR_APP_ROOT:-$HOME/Library/Application Support/Prostar}"
RUNTIME_ROOT="$APP_ROOT/runtime"
RUNTIME_BIN="$RUNTIME_ROOT/bin"
INSTALL_CLOUDFLARED=0
STAGING_DIR=""

case "${1:---node-only}" in
  --node-only) ;;
  --with-cloudflared) INSTALL_CLOUDFLARED=1 ;;
  *)
    printf 'Unknown Prostar runtime option: %s\n' "$1" >&2
    exit 2
    ;;
esac

die() {
  printf 'Prostar runtime error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$STAGING_DIR" && "$STAGING_DIR" == "$RUNTIME_ROOT"/.staging.* ]]; then
    rm -rf "$STAGING_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

[[ "$(/usr/bin/uname -s)" == "Darwin" ]] || die "macOS is required."
if [[ -L "$RUNTIME_ROOT" || ( -e "$RUNTIME_ROOT" && ! -d "$RUNTIME_ROOT" ) ]]; then
  die "$RUNTIME_ROOT must be an ordinary directory."
fi
mkdir -p "$RUNTIME_ROOT" "$RUNTIME_BIN"
printf '%s\n' 'Prostar managed runtime' > "$RUNTIME_ROOT/.prostar-runtime"

# Serialize upgrades from overlapping setup commands without elevated access.
if [[ "${PROSTAR_RUNTIME_LOCKED:-0}" != "1" ]]; then
  export PROSTAR_RUNTIME_LOCKED=1
  exec /usr/bin/lockf -k -t 120 "$RUNTIME_ROOT/.install.lock" /bin/bash "$0" "$@"
fi

machine_arch() {
  local arm64 translated machine
  arm64="$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)"
  translated="$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null || true)"
  machine="$(/usr/bin/uname -m)"
  if [[ "$arm64" == "1" || "$translated" == "1" || "$machine" == "arm64" ]]; then
    printf '%s' 'arm64'
  elif [[ "$machine" == "x86_64" ]]; then
    printf '%s' 'x64'
  else
    die "Unsupported Mac architecture: $machine"
  fi
}

verify_hash() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(/usr/bin/shasum -a 256 "$file" | /usr/bin/awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || die "Checksum verification failed for $(/usr/bin/basename "$file")."
}

hash_matches() {
  local file="$1"
  local expected="$2"
  local actual
  [[ -f "$file" ]] || return 1
  actual="$(/usr/bin/shasum -a 256 "$file" | /usr/bin/awk '{print $1}')"
  [[ "$actual" == "$expected" ]]
}

download() {
  local url="$1"
  local destination="$2"
  /usr/bin/curl -q --proto '=https' --tlsv1.2 \
    --retry 3 --retry-all-errors --connect-timeout 20 \
    -fsSL "$url" -o "$destination"
}

atomic_link() {
  local source="$1"
  local destination="$2"
  local pending="$RUNTIME_BIN/.link.$$.${destination##*/}"
  if [[ -e "$destination" && ! -L "$destination" ]]; then
    die "$destination is not a Prostar-managed link."
  fi
  ln -s "$source" "$pending"
  mv -hf "$pending" "$destination"
}

promote_directory() {
  local source="$1"
  local destination="$2"
  local backup=""
  if [[ -e "$destination" ]]; then
    backup="$RUNTIME_ROOT/.previous.$$.${destination##*/}"
    mv "$destination" "$backup"
  fi
  if mv "$source" "$destination"; then
    [[ -z "$backup" ]] || rm -rf "$backup"
  else
    [[ -z "$backup" ]] || mv "$backup" "$destination" || true
    return 1
  fi
}

install_node() {
  local architecture node_arch archive_hash archive_name archive_url
  local install_name install_path extracted
  architecture="$(machine_arch)"
  if [[ "$architecture" == "arm64" ]]; then
    node_arch="arm64"
    archive_hash="8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d"
  else
    node_arch="x64"
    archive_hash="d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316"
  fi
  archive_name="node-v${NODE_VERSION}-darwin-${node_arch}.tar.gz"
  archive_url="https://nodejs.org/dist/v${NODE_VERSION}/${archive_name}"
  install_name="node-v${NODE_VERSION}-darwin-${node_arch}"
  install_path="$RUNTIME_ROOT/$install_name"

  if [[ ! -x "$install_path/bin/node" || "$($install_path/bin/node --version 2>/dev/null || true)" != "v$NODE_VERSION" ]]; then
    STAGING_DIR="$(/usr/bin/mktemp -d "$RUNTIME_ROOT/.staging.node.XXXXXX")"
    download "$archive_url" "$STAGING_DIR/$archive_name"
    verify_hash "$STAGING_DIR/$archive_name" "$archive_hash"
    while IFS= read -r member; do
      case "$member" in
        "$install_name"|"$install_name"/*) ;;
        *) die "The Node.js archive contains an unexpected path." ;;
      esac
    done < <(/usr/bin/tar -tzf "$STAGING_DIR/$archive_name")
    /usr/bin/tar -xzf "$STAGING_DIR/$archive_name" -C "$STAGING_DIR"
    extracted="$STAGING_DIR/$install_name"
    [[ -x "$extracted/bin/node" && -x "$extracted/bin/npm" ]] || die "The Node.js archive is incomplete."
    [[ "$($extracted/bin/node --version)" == "v$NODE_VERSION" ]] || die "The Node.js archive has the wrong version."
    promote_directory "$extracted" "$install_path"
    rm -rf "$STAGING_DIR"
    STAGING_DIR=""
  fi

  atomic_link "$install_path/bin/node" "$RUNTIME_BIN/node"
  atomic_link "$install_path/bin/npm" "$RUNTIME_BIN/npm"
  atomic_link "$install_path/bin/npx" "$RUNTIME_BIN/npx"
  if [[ -e "$install_path/bin/corepack" ]]; then
    atomic_link "$install_path/bin/corepack" "$RUNTIME_BIN/corepack"
  fi
}

install_cloudflared() {
  local os_major architecture cloud_arch archive_hash binary_hash
  local archive_name archive_url install_path extracted
  os_major="$(/usr/bin/sw_vers -productVersion | /usr/bin/cut -d. -f1)"
  [[ "$os_major" =~ ^[0-9]+$ && "$os_major" -ge 15 ]] || \
    die "Remote viewing requires macOS 15 or later."

  architecture="$(machine_arch)"
  if [[ "$architecture" == "arm64" ]]; then
    cloud_arch="arm64"
    archive_hash="9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442"
    binary_hash="b61054d3d6326ea558cb49826eebf5676e0d0a36d51b546975096ca3e0e3c89d"
  else
    cloud_arch="amd64"
    archive_hash="f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4"
    binary_hash="b0f770e1e0b281399a57219b840fd8eef1cc25387a404124248157ea2073727a"
  fi
  archive_name="cloudflared-darwin-${cloud_arch}.tgz"
  archive_url="https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${archive_name}"
  install_path="$RUNTIME_ROOT/cloudflared-${CLOUDFLARED_VERSION}-${cloud_arch}"

  if [[ ! -x "$install_path/cloudflared" ]] || \
     ! hash_matches "$install_path/cloudflared" "$binary_hash"; then
    STAGING_DIR="$(/usr/bin/mktemp -d "$RUNTIME_ROOT/.staging.cloudflared.XXXXXX")"
    download "$archive_url" "$STAGING_DIR/$archive_name"
    verify_hash "$STAGING_DIR/$archive_name" "$archive_hash"
    [[ "$(/usr/bin/tar -tzf "$STAGING_DIR/$archive_name")" == "cloudflared" ]] || \
      die "The cloudflared archive contains an unexpected path."
    mkdir "$STAGING_DIR/extracted"
    /usr/bin/tar -xzf "$STAGING_DIR/$archive_name" -C "$STAGING_DIR/extracted"
    extracted="$STAGING_DIR/extracted/cloudflared"
    [[ -f "$extracted" ]] || die "The cloudflared archive is incomplete."
    verify_hash "$extracted" "$binary_hash"
    chmod 700 "$extracted"
    "$extracted" --version | /usr/bin/grep -F "cloudflared version $CLOUDFLARED_VERSION" >/dev/null || \
      die "The cloudflared archive has the wrong version."
    promote_directory "$STAGING_DIR/extracted" "$install_path"
    rm -rf "$STAGING_DIR"
    STAGING_DIR=""
  fi

  atomic_link "$install_path/cloudflared" "$RUNTIME_BIN/cloudflared"
}

install_node
if [[ "$INSTALL_CLOUDFLARED" == "1" ]]; then
  install_cloudflared
fi

"$RUNTIME_BIN/node" -e 'const [major] = process.versions.node.split(".").map(Number); process.exit(major === 24 ? 0 : 1)'
if [[ "$INSTALL_CLOUDFLARED" == "1" ]]; then
  "$RUNTIME_BIN/cloudflared" --version >/dev/null
fi
