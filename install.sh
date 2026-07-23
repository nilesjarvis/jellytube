#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly APP_NAME="jellytube"
readonly SERVICE_NAME="jellytube.service"
readonly INSTALL_ROOT="/opt/jellytube"
readonly CONFIG_ROOT="/etc/jellytube"
readonly CONFIG_FILE="$CONFIG_ROOT/jellytube.env"
readonly UNIT_FILE="/etc/systemd/system/$SERVICE_NAME"
readonly INSTALL_LOCK="/run/lock/jellytube-install.lock"

repository="${JELLYTUBE_REPOSITORY:-nilesjarvis/jellytube}"
source_ref="${JELLYTUBE_REF:-main}"
service_host="${JELLYTUBE_HOST:-0.0.0.0}"
service_port="${JELLYTUBE_PORT:-4173}"
node_major="${JELLYTUBE_NODE_MAJOR:-22}"
temporary_directory=""

info() {
  printf '[JellyTube] %s\n' "$*"
}

fail() {
  printf '[JellyTube] Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install or upgrade JellyTube as a systemd service.

Usage:
  sudo bash install.sh
  curl -fsSL https://raw.githubusercontent.com/nilesjarvis/jellytube/main/install.sh | sudo bash

First-install settings:
  JELLYTUBE_HOST          Listening address (default: 0.0.0.0)
  JELLYTUBE_PORT          Listening port (default: 4173)
  JELLYTUBE_REF           Git tag, branch, or commit to install (default: main)
  JELLYTUBE_REPOSITORY    GitHub owner/repository (default: nilesjarvis/jellytube)
  JELLYTUBE_NODE_MAJOR    Private Node.js runtime major (default: 22)

Existing /etc/jellytube/jellytube.env settings are preserved during upgrades.
EOF
}

cleanup() {
  if [[ -n "$temporary_directory" && -d "$temporary_directory" ]]; then
    rm -rf -- "$temporary_directory"
  fi
}

download() {
  local url="$1"
  local destination="$2"
  curl \
    --fail \
    --silent \
    --show-error \
    --location \
    --retry 3 \
    --proto '=https' \
    --tlsv1.2 \
    --output "$destination" \
    "$url" \
    </dev/null
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

create_service_account() {
  local nologin_shell

  if ! getent group "$APP_NAME" >/dev/null 2>&1; then
    groupadd --system "$APP_NAME"
  fi

  if id -u "$APP_NAME" >/dev/null 2>&1; then
    return
  fi

  nologin_shell="$(command -v nologin || true)"
  if [[ -z "$nologin_shell" ]]; then
    nologin_shell="/bin/false"
  fi

  useradd \
    --system \
    --gid "$APP_NAME" \
    --home-dir "$INSTALL_ROOT" \
    --no-create-home \
    --shell "$nologin_shell" \
    "$APP_NAME"
}

install_node_runtime() {
  local node_archive="$1"
  local node_directory_name="$2"
  local incoming_runtime="$INSTALL_ROOT/runtime/.${node_directory_name}.incoming.$$"

  node_runtime_directory="$INSTALL_ROOT/runtime/$node_directory_name"
  if [[ -x "$node_runtime_directory/bin/node" ]]; then
    return
  fi

  install -d -o root -g root -m 0755 "$INSTALL_ROOT/runtime"
  install -d -o root -g root -m 0755 "$incoming_runtime"
  tar -xzf "$node_archive" -C "$incoming_runtime" --strip-components=1
  chown -R root:root "$incoming_runtime"
  chmod -R go-w "$incoming_runtime"
  mv "$incoming_runtime" "$node_runtime_directory"
}

restore_previous_release() {
  local previous_release="$1"
  local previous_node="$2"

  if [[ -n "$previous_release" ]]; then
    ln -sfn "$previous_release" "$INSTALL_ROOT/current"
  else
    rm -f -- "$INSTALL_ROOT/current"
  fi

  if [[ -n "$previous_node" ]]; then
    ln -sfn "$previous_node" "$INSTALL_ROOT/node"
  else
    rm -f -- "$INSTALL_ROOT/node"
  fi

  systemctl daemon-reload || true
  if [[ -n "$previous_release" && -n "$previous_node" ]]; then
    systemctl restart "$SERVICE_NAME" || true
  else
    systemctl stop "$SERVICE_NAME" || true
  fi
}

show_recent_logs() {
  if command -v journalctl >/dev/null 2>&1; then
    journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2 || true
  fi
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

[[ "$#" -eq 0 ]] || fail "Unknown argument: $1. Use --help for usage."
[[ "$(uname -s)" == "Linux" ]] || fail "The systemd installer only supports Linux."
[[ "$EUID" -eq 0 ]] || fail "Run this installer as root, for example by piping it to 'sudo bash'."

for required_command in \
  awk \
  chown \
  chmod \
  cp \
  curl \
  date \
  find \
  flock \
  getent \
  groupadd \
  id \
  install \
  ln \
  mktemp \
  mv \
  readlink \
  rm \
  sed \
  sha256sum \
  systemctl \
  tar \
  uname \
  useradd; do
  require_command "$required_command"
done

[[ -d /run/systemd/system ]] || fail "systemd is not running on this device."
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "Invalid JELLYTUBE_REPOSITORY: $repository"
[[ "$source_ref" =~ ^[A-Za-z0-9._-]+$ ]] || fail "Invalid JELLYTUBE_REF: $source_ref"
[[ "$service_host" =~ ^[A-Za-z0-9._:-]+$ ]] || fail "Invalid JELLYTUBE_HOST: $service_host"
[[ "$service_port" =~ ^[0-9]+$ ]] || fail "Invalid JELLYTUBE_PORT: $service_port"
((10#$service_port >= 1024 && 10#$service_port <= 65535)) ||
  fail "JELLYTUBE_PORT must be between 1024 and 65535."
[[ "$node_major" =~ ^[0-9]+$ ]] || fail "Invalid JELLYTUBE_NODE_MAJOR: $node_major"
((10#$node_major >= 20)) || fail "JELLYTUBE_NODE_MAJOR must be 20 or newer."

case "$(uname -m)" in
  x86_64 | amd64)
    node_architecture="x64"
    ;;
  aarch64 | arm64)
    node_architecture="arm64"
    ;;
  *)
    fail "Unsupported CPU architecture: $(uname -m). Supported architectures: x86_64 and arm64."
    ;;
esac

exec 9>"$INSTALL_LOCK"
flock -n 9 || fail "Another JellyTube installation is already running."

temporary_directory="$(mktemp -d /tmp/jellytube-install.XXXXXX)"
trap cleanup EXIT

source_archive="$temporary_directory/jellytube-source.tar.gz"
source_manifest="$temporary_directory/source-manifest.txt"
source_directory="$temporary_directory/source"
source_url="https://github.com/$repository/archive/$source_ref.tar.gz"

info "Downloading $repository at $source_ref..."
download "$source_url" "$source_archive"
tar -tzf "$source_archive" >"$source_manifest"
archive_first_entry="$(sed -n '1p' "$source_manifest")"
archive_root="${archive_first_entry%%/*}"
[[ -n "$archive_root" ]] || fail "The JellyTube source archive is empty."

if awk -v prefix="$archive_root/" 'index($0, prefix) != 1 { invalid = 1 } END { exit !invalid }' "$source_manifest"; then
  fail "The JellyTube source archive contains an unexpected path."
fi

install -d -m 0755 "$source_directory"
tar -xzf "$source_archive" -C "$source_directory" --strip-components=1
[[ -f "$source_directory/package.json" ]] || fail "The source archive is missing package.json."
[[ -f "$source_directory/package-lock.json" ]] || fail "The source archive is missing package-lock.json."
[[ -f "$source_directory/scripts/serve-dist.mjs" ]] ||
  fail "The source archive is missing scripts/serve-dist.mjs."
[[ -f "$source_directory/packaging/systemd/jellytube.service" ]] ||
  fail "The source archive is missing packaging/systemd/jellytube.service."

node_release_root="https://nodejs.org/dist/latest-v${node_major}.x"
node_checksums="$temporary_directory/node-shasums.txt"
info "Resolving the latest Node.js $node_major runtime..."
download "$node_release_root/SHASUMS256.txt" "$node_checksums"

node_archive_name="$(
  awk -v suffix="-linux-${node_architecture}.tar.gz" \
    'length($2) >= length(suffix) && substr($2, length($2) - length(suffix) + 1) == suffix { print $2; exit }' \
    "$node_checksums"
)"
[[ -n "$node_archive_name" ]] ||
  fail "Node.js $node_major does not provide a linux-$node_architecture runtime."

node_archive="$temporary_directory/$node_archive_name"
expected_node_hash="$(awk -v file="$node_archive_name" '$2 == file { print $1; exit }' "$node_checksums")"
[[ -n "$expected_node_hash" ]] || fail "No checksum found for $node_archive_name."

info "Downloading and verifying $node_archive_name..."
download "$node_release_root/$node_archive_name" "$node_archive"
actual_node_hash="$(sha256sum "$node_archive" | awk '{ print $1 }')"
[[ "$actual_node_hash" == "$expected_node_hash" ]] ||
  fail "Checksum verification failed for $node_archive_name."

build_node_directory="$temporary_directory/node"
install -d -m 0755 "$build_node_directory"
tar -xzf "$node_archive" -C "$build_node_directory" --strip-components=1
export PATH="$build_node_directory/bin:$PATH"
export npm_config_cache="$temporary_directory/npm-cache"

info "Installing build dependencies..."
(
  cd "$source_directory"
  npm ci --no-audit --no-fund </dev/null
)

info "Building JellyTube..."
(
  cd "$source_directory"
  npm run build </dev/null
)

[[ -f "$source_directory/dist/index.html" ]] || fail "The JellyTube build did not produce dist/index.html."

app_version="$(
  awk -F '"' '/"version"[[:space:]]*:/ { print $4; exit }' "$source_directory/package.json"
)"
[[ -n "$app_version" ]] || app_version="unknown"
safe_version="${app_version//[^A-Za-z0-9._-]/-}"
safe_ref="${source_ref//[^A-Za-z0-9._-]/-}"
release_id="${safe_version}-${safe_ref}-$(date -u +%Y%m%d%H%M%S)-$$"
release_directory="$INSTALL_ROOT/releases/$release_id"
incoming_release="$INSTALL_ROOT/releases/.${release_id}.incoming"
node_directory_name="${node_archive_name%.tar.gz}"

info "Installing release $release_id..."
create_service_account
install -d -o root -g root -m 0755 "$INSTALL_ROOT" "$INSTALL_ROOT/releases" "$CONFIG_ROOT"

node_runtime_directory=""
install_node_runtime "$node_archive" "$node_directory_name"
"$node_runtime_directory/bin/node" -e \
  "const major = Number(process.versions.node.split('.')[0]); process.exit(major === $node_major ? 0 : 1);" ||
  fail "The installed Node.js runtime failed validation."

install -d -o root -g root -m 0755 "$incoming_release"
cp -a "$source_directory/dist" "$incoming_release/dist"
install -d -o root -g root -m 0755 "$incoming_release/scripts"
install -o root -g root -m 0644 \
  "$source_directory/scripts/serve-dist.mjs" \
  "$incoming_release/scripts/serve-dist.mjs"
printf '%s\n' "$release_id" >"$incoming_release/VERSION"
chown -R root:root "$incoming_release"
find "$incoming_release" -type d -exec chmod 0755 {} +
find "$incoming_release" -type f -exec chmod 0644 {} +
mv "$incoming_release" "$release_directory"

if [[ ! -f "$CONFIG_FILE" ]]; then
  config_staging="$temporary_directory/jellytube.env"
  {
    printf 'JELLYTUBE_HOST=%s\n' "$service_host"
    printf 'JELLYTUBE_PORT=%s\n' "$service_port"
  } >"$config_staging"
  install -o root -g "$APP_NAME" -m 0640 "$config_staging" "$CONFIG_FILE"
  info "Created $CONFIG_FILE."
else
  info "Keeping existing configuration at $CONFIG_FILE."
fi

install -o root -g root -m 0644 \
  "$source_directory/packaging/systemd/jellytube.service" \
  "$UNIT_FILE"

previous_release=""
previous_node=""
if [[ -L "$INSTALL_ROOT/current" ]]; then
  previous_release="$(readlink "$INSTALL_ROOT/current")"
fi
if [[ -L "$INSTALL_ROOT/node" ]]; then
  previous_node="$(readlink "$INSTALL_ROOT/node")"
fi

info "Enabling $SERVICE_NAME at boot..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null

ln -sfn "$release_directory" "$INSTALL_ROOT/current"
ln -sfn "$node_runtime_directory" "$INSTALL_ROOT/node"

info "Starting $SERVICE_NAME..."
if ! systemctl restart "$SERVICE_NAME"; then
  show_recent_logs
  restore_previous_release "$previous_release" "$previous_node"
  fail "$SERVICE_NAME could not be started; the previous release was restored."
fi

configured_host="$(
  sed -n 's/^JELLYTUBE_HOST=//p' "$CONFIG_FILE" | sed -n '1p'
)"
configured_port="$(
  sed -n 's/^JELLYTUBE_PORT=//p' "$CONFIG_FILE" | sed -n '1p'
)"
configured_host="${configured_host:-0.0.0.0}"
configured_port="${configured_port:-4173}"

case "$configured_host" in
  0.0.0.0)
    health_host="127.0.0.1"
    ;;
  ::)
    health_host="[::1]"
    ;;
  *:*)
    health_host="[$configured_host]"
    ;;
  *)
    health_host="$configured_host"
    ;;
esac
health_url="http://$health_host:$configured_port/healthz"

healthy=false
for ((attempt = 1; attempt <= 30; attempt += 1)); do
  if curl --fail --silent --show-error --max-time 2 --noproxy '*' "$health_url" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 0.5
done

if [[ "$healthy" != true ]]; then
  show_recent_logs
  restore_previous_release "$previous_release" "$previous_node"
  fail "$SERVICE_NAME did not pass its health check at $health_url; the previous release was restored."
fi

info "JellyTube $app_version is installed and running."
printf 'URL: http://%s:%s\n' "$health_host" "$configured_port"
printf 'Configuration: %s\n' "$CONFIG_FILE"
printf 'Status: systemctl status %s\n' "$SERVICE_NAME"
printf 'Logs: journalctl -u %s -f\n' "$SERVICE_NAME"
