#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/WithZeng/Web-rearcher.git}"
REPO_BRANCH="${REPO_BRANCH:-codex/server-compose-grobid}"
INSTALL_DIR="${INSTALL_DIR:-/opt/web-rearcher}"

log() {
  printf '[bootstrap-install] %s\n' "$1"
}

fail() {
  printf '[bootstrap-install] ERROR: %s\n' "$1" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "Please run with sudo."
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
      ;;
    *)
      fail "Unsupported OS '${ID}'. This script supports Ubuntu and Debian."
      ;;
  esac
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

ensure_bootstrap_tools() {
  local missing=()

  if ! command -v git >/dev/null 2>&1; then
    missing+=("git")
  fi
  if ! command -v curl >/dev/null 2>&1; then
    missing+=("curl")
  fi

  if (( ${#missing[@]} == 0 )); then
    return
  fi

  log "Installing required bootstrap tools: ${missing[*]}"
  apt-get update
  apt_install ca-certificates curl git
}

prepare_repo() {
  install -d -m 0755 "$(dirname "${INSTALL_DIR}")"

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Updating existing repository in ${INSTALL_DIR}"
    git -C "${INSTALL_DIR}" fetch --tags origin
    git -C "${INSTALL_DIR}" checkout "${REPO_BRANCH}"
    git -C "${INSTALL_DIR}" pull --ff-only origin "${REPO_BRANCH}"
  else
    if [[ -e "${INSTALL_DIR}" && ! -d "${INSTALL_DIR}" ]]; then
      fail "Install path ${INSTALL_DIR} exists and is not a directory."
    fi

    log "Cloning ${REPO_URL} (${REPO_BRANCH}) into ${INSTALL_DIR}"
    rm -rf "${INSTALL_DIR}"
    git clone --branch "${REPO_BRANCH}" --single-branch "${REPO_URL}" "${INSTALL_DIR}"
  fi
}

run_deploy() {
  log "Running repository deployment script"
  bash "${INSTALL_DIR}/scripts/server-deploy.sh"
}

print_summary() {
  log "Repository: ${REPO_URL}"
  log "Branch: ${REPO_BRANCH}"
  log "Install dir: ${INSTALL_DIR}"
}

main() {
  require_root
  require_supported_os
  ensure_bootstrap_tools
  prepare_repo
  run_deploy
  print_summary
}

main "$@"
