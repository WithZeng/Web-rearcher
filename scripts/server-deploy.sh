#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DOCKER_GPG_KEYRING="/etc/apt/keyrings/docker.asc"
DOCKER_SOURCE_LIST="/etc/apt/sources.list.d/docker.list"

log() {
  printf '[server-deploy] %s\n' "$1"
}

fail() {
  printf '[server-deploy] ERROR: %s\n' "$1" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "Please run with sudo: sudo bash scripts/server-deploy.sh"
  fi
}

require_supported_os() {
  if [[ ! -f /etc/os-release ]]; then
    fail "Cannot detect OS. This script supports Ubuntu and Debian."
  fi

  # shellcheck disable=SC1091
  source /etc/os-release

  case "${ID}" in
    ubuntu|debian)
      OS_ID="${ID}"
      OS_CODENAME="${VERSION_CODENAME:-}"
      ;;
    *)
      fail "Unsupported OS '${ID}'. This script supports Ubuntu and Debian."
      ;;
  esac

  if [[ -z "${OS_CODENAME}" ]]; then
    fail "Unable to determine OS codename from /etc/os-release."
  fi
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

ensure_host_tools() {
  if command -v curl >/dev/null 2>&1; then
    return
  fi

  log "Installing curl for health checks"
  apt-get update
  apt_install ca-certificates curl
}

configure_docker_repo() {
  install -m 0755 -d /etc/apt/keyrings

  if [[ ! -f "${DOCKER_GPG_KEYRING}" ]]; then
    curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" -o "${DOCKER_GPG_KEYRING}"
    chmod a+r "${DOCKER_GPG_KEYRING}"
  fi

  local arch
  arch="$(dpkg --print-architecture)"
  printf 'deb [arch=%s signed-by=%s] https://download.docker.com/linux/%s %s stable\n' \
    "${arch}" "${DOCKER_GPG_KEYRING}" "${OS_ID}" "${OS_CODENAME}" > "${DOCKER_SOURCE_LIST}"
}

install_docker_stack() {
  log "Installing Docker Engine and Docker Compose plugin"
  apt-get update
  apt_install ca-certificates curl gnupg
  configure_docker_repo
  apt-get update
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

ensure_docker_stack() {
  local needs_install=0

  if ! command -v docker >/dev/null 2>&1; then
    needs_install=1
  elif ! docker compose version >/dev/null 2>&1; then
    needs_install=1
  fi

  if [[ "${needs_install}" -eq 1 ]]; then
    install_docker_stack
  elif ! systemctl is-active --quiet docker; then
    log "Starting Docker service"
    systemctl enable --now docker
  fi
}

ensure_env_file() {
  if [[ ! -f .env ]]; then
    if [[ -f .env.example ]]; then
      cp .env.example .env
    else
      : > .env
    fi
    log "Created .env from template"
  fi
}

ensure_models_file() {
  if [[ ! -f models.json ]]; then
    printf '[]\n' > models.json
    log "Created empty models.json"
  fi
}

upsert_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"

  if grep -q "^${key}=" "${file}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${file}"
  else
    printf '\n%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
}

ensure_runtime_files() {
  mkdir -p output
  ensure_env_file
  ensure_models_file

  local current_grobid
  current_grobid="$(grep -E '^GROBID_URL=' .env | head -n 1 | cut -d= -f2- || true)"
  if [[ -z "${current_grobid}" ]]; then
    upsert_env_value "GROBID_URL" "http://grobid:8070" ".env"
    log "Defaulted GROBID_URL to http://grobid:8070"
  fi
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local max_attempts="${3:-60}"
  local sleep_seconds="${4:-2}"
  local attempt=1

  until curl --fail --silent --show-error "${url}" >/dev/null; do
    if (( attempt >= max_attempts )); then
      fail "${name} did not become ready at ${url}"
    fi
    sleep "${sleep_seconds}"
    attempt=$((attempt + 1))
  done
}

deploy_stack() {
  log "Building and starting docker compose services"
  docker compose up -d --build
}

print_summary() {
  log "Frontend: http://127.0.0.1:3000"
  log "Backend:  http://127.0.0.1:8000"
  log "Health:   http://127.0.0.1:8000/api/health"
  log "Logs:     docker compose logs -f backend frontend grobid"
}

main() {
  require_root
  require_supported_os
  ensure_host_tools
  ensure_docker_stack
  ensure_runtime_files
  deploy_stack

  log "Waiting for backend health endpoint"
  wait_for_http "Backend" "http://127.0.0.1:8000/api/health"
  log "Waiting for frontend"
  wait_for_http "Frontend" "http://127.0.0.1:3000"

  print_summary
}

main "$@"
