#!/usr/bin/env sh
# install.sh — installer for lightinator-log-service
#
# Supported install methods (detected automatically):
#   quadlet  — Podman Quadlet unit (podman ≥ 4.4 + systemd)
#   systemd  — systemd .service file (podman or docker + systemd)
#   openrc   — Alpine OpenRC init script
#
# Usage:
#   ./install.sh            interactive
#   ./install.sh --help
set -eu

SERVICE_NAME=lightinator-log-service
IMAGE="ghcr.io/pljakobs/lightinator-log-service:prod"
SYS_DATA="/var/lib/${SERVICE_NAME}/data"
USR_DATA="${HOME}/${SERVICE_NAME}/data"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
QUADLET_SRC="${SCRIPT_DIR}/quadlet/${SERVICE_NAME}@.container"
ENV_EXAMPLE="${SCRIPT_DIR}/config/service.env.example"

# ── terminal helpers ──────────────────────────────────────────────────────────
_grn() { printf '\033[0;32m%s\033[0m\n' "$*"; }
_yel() { printf '\033[0;33m%s\033[0m\n' "$*"; }
_red() { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
info()  { _grn "  ✓  $*"; }
warn()  { _yel "  !  $*"; }
die()   { _red "  ✗  $*"; exit 1; }

# yn "Question?" [y|n default]  → returns 0/1
yn() {
  local q="$1" def="${2:-y}" r hint
  [ "$def" = y ] && hint="[Y/n]" || hint="[y/N]"
  printf '  \033[0;34m?\033[0m  %s %s ' "$q" "$hint"
  read -r r 2>/dev/null || r="$def"
  r="${r:-$def}"
  case "$r" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# ── detection helpers ─────────────────────────────────────────────────────────
has()     { command -v "$1" >/dev/null 2>&1; }
is_root() { [ "$(id -u)" -eq 0 ]; }
is_alpine()  { [ -f /etc/alpine-release ]; }
has_systemd(){ has systemctl && systemctl --version >/dev/null 2>&1; }
has_openrc() { has rc-update && has rc-service; }

podman_version() { podman --version 2>/dev/null | awk '{print $3}'; }
podman_quadlet() {
  has podman || return 1
  _ver=$(podman_version)
  _maj=$(printf '%s' "$_ver" | cut -d. -f1)
  _min=$(printf '%s' "$_ver" | cut -d. -f2)
  { [ "$_maj" -gt 4 ] || { [ "$_maj" -eq 4 ] && [ "$_min" -ge 4 ]; }; }
}

runtime() {
  if   has podman; then printf 'podman'
  elif has docker; then printf 'docker'
  else die "Neither podman nor docker is installed."; fi
}

# ── scope selection ───────────────────────────────────────────────────────────
# Sets global variable $scope (cannot use stdout — would be captured in $())
scope=system
ask_scope() {
  if is_root; then
    yn "Install system-wide (all users)?" y && scope=system || scope=user
  else
    warn "Running as non-root — system-wide install requires sudo."
    yn "Install as current user (--user systemd scope)?" y \
      && scope=user \
      || die "Re-run with sudo for a system-wide install."
  fi
}

# ── env file ──────────────────────────────────────────────────────────────────
place_env() {
  local data="$1" dest
  dest="${data}/service.env"
  mkdir -p "$data"
  if [ -f "$dest" ]; then
    warn "service.env already exists at $dest — left unchanged"
    return 0
  fi
  if [ ! -f "$ENV_EXAMPLE" ]; then
    warn "config/service.env.example not found; skipping env file"
    return 0
  fi
  cp "$ENV_EXAMPLE" "$dest"
  info "Env file placed: $dest"
  printf '      Review and edit it to set LLS_DISCOVERY_SEEDS and other options.\n'
  yn "Open service.env in editor now?" n && ${EDITOR:-vi} "$dest" || true
}

# ── Podman Quadlet ────────────────────────────────────────────────────────────
do_quadlet() {
  local scope="$1" dest data ctl image_tag unit_name
  if [ "$scope" = system ]; then
    dest=/etc/containers/systemd
    data=$SYS_DATA
    ctl=systemctl
  else
    dest="${XDG_CONFIG_HOME:-${HOME}/.config}/containers/systemd"
    data=$USR_DATA
    ctl="systemctl --user"
  fi

  printf '\n  \033[1mQuadlet install\033[0m  (scope: %s)\n\n' "$scope"

  # ── select image flavour ────────────────────────────────────────────────────
  printf '  \033[0;34m?\033[0m  Image flavour:\n'
  printf '    1) prod     (stable, merged to prod branch)  — recommended\n'
  printf '    2) develop  (latest development build)\n'
  printf '    Choice [1]: '
  read -r _pick 2>/dev/null || _pick=1
  case "${_pick:-1}" in
    2) image_tag=develop ;;
    *) image_tag=prod ;;
  esac
  info "Using image tag: $image_tag"
  unit_name="${SERVICE_NAME}@${image_tag}"

  [ -f "$QUADLET_SRC" ] || die "Quadlet source not found: $QUADLET_SRC"
  mkdir -p "$dest" "$data"

  # ── transition: remove old non-template unit if present ──────────────────
  _old_unit="${dest}/${SERVICE_NAME}.container"
  if [ -f "$_old_unit" ]; then
    warn "Found existing non-template unit at $_old_unit — migrating to template."
    $ctl stop "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$_old_unit"
    info "Old unit removed."
  fi

  # ── install template unit ──────────────────────────────────────────────────
  if [ "$scope" = user ]; then
    # patch volume and EnvironmentFile paths for per-user layout
    sed "s|/var/lib/${SERVICE_NAME}/data|${data}|g" \
      "$QUADLET_SRC" > "${dest}/${SERVICE_NAME}@.container"
  else
    cp "$QUADLET_SRC" "${dest}/${SERVICE_NAME}@.container"
  fi
  info "Quadlet template unit → ${dest}/${SERVICE_NAME}@.container"

  place_env "$data"

  $ctl daemon-reload
  info "daemon-reload complete"

  if yn "Start ${unit_name} now?" y; then
    # Quadlet units are auto-enabled via WantedBy= in the .container file.
    # 'enable' is not supported on generated units — just start.
    $ctl start "$unit_name"
    info "Service started"
  fi

  if yn "Enable podman-auto-update.timer (auto-restarts on new :${image_tag} image)?" y; then
    $ctl enable --now podman-auto-update.timer
    info "podman-auto-update.timer enabled"
  else
    warn "Auto-update not enabled. Run 'systemctl restart ${unit_name}' to pull manually."
  fi
}

# ── systemd service unit (non-quadlet) ───────────────────────────────────────
do_systemd() {
  local scope="$1" rt dest data ctl wantedby envfile unit
  rt=$(runtime)

  if [ "$scope" = system ]; then
    dest=/etc/systemd/system
    data=$SYS_DATA
    ctl=systemctl
    wantedby=multi-user.target
  else
    dest="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
    data=$USR_DATA
    ctl="systemctl --user"
    wantedby=default.target
  fi
  envfile="${data}/service.env"
  unit="${dest}/${SERVICE_NAME}.service"

  printf '\n  \033[1mSystemd service unit install\033[0m  (runtime: %s  scope: %s)\n\n' "$rt" "$scope"

  mkdir -p "$dest" "$data"
  place_env "$data"

  # Generate the service unit.  \$ escapes are for literals that systemd
  # should not expand (none needed here, but kept for readability).
  cat > "$unit" << UNIT
[Unit]
Description=Lightinator Log Service
Documentation=https://github.com/pljakobs/lightinator-log-service
After=network-online.target
Wants=network-online.target

[Service]
Restart=always
RestartSec=5
ExecStartPre=-${rt} rm -f ${SERVICE_NAME}
ExecStart=${rt} run --rm \
    --name ${SERVICE_NAME} \
    --network host \
    -v ${data}:/app/data:z \
    --env-file ${envfile} \
    ${IMAGE}
ExecStop=${rt} stop ${SERVICE_NAME}

[Install]
WantedBy=${wantedby}
UNIT

  info "Service unit → $unit"
  $ctl daemon-reload

  if yn "Enable and start ${SERVICE_NAME} now?" y; then
    $ctl enable --now "$SERVICE_NAME"
    info "Service enabled and started"
  fi
}

# ── Alpine OpenRC ─────────────────────────────────────────────────────────────
do_openrc() {
  local rt envfile initd
  is_root || die "OpenRC install requires root. Re-run with sudo."
  rt=$(runtime)
  envfile="${SYS_DATA}/service.env"
  initd="/etc/init.d/${SERVICE_NAME}"

  printf '\n  \033[1mOpenRC init script install\033[0m  (runtime: %s)\n\n' "$rt"

  mkdir -p "$SYS_DATA"
  place_env "$SYS_DATA"

  cat > "$initd" << INITD
#!/sbin/openrc-run
name="${SERVICE_NAME}"
description="Lightinator Log Service"
pidfile="/run/\${RC_SVCNAME}.pid"

depend() {
    need net
    after firewall logger
}

start() {
    ebegin "Starting \${name}"
    ${rt} run --rm -d \\
        --name ${SERVICE_NAME} \\
        --network host \\
        -v ${SYS_DATA}:/app/data:z \\
        --env-file ${envfile} \\
        ${IMAGE}
    eend \$?
}

stop() {
    ebegin "Stopping \${name}"
    ${rt} stop ${SERVICE_NAME} 2>/dev/null || true
    eend 0
}

status() {
    if ${rt} ps --format '{{.Names}}' | grep -Fxq '${SERVICE_NAME}'; then
        einfo "\${name} is running"
        return 0
    else
        einfo "\${name} is stopped"
        return 3
    fi
}
INITD

  chmod +x "$initd"
  info "Init script → $initd"

  if yn "Add ${SERVICE_NAME} to default runlevel?" y; then
    rc-update add "$SERVICE_NAME" default
    info "Added to default runlevel"
  fi

  if yn "Start ${SERVICE_NAME} now?" y; then
    rc-service "$SERVICE_NAME" start
  fi
}

# ── usage ─────────────────────────────────────────────────────────────────────
usage() {
  cat << 'USAGE'
Usage: ./install.sh [--help]

Interactive installer for lightinator-log-service.

The installer auto-detects what is available on this system and offers:
  quadlet   Podman Quadlet unit (podman >= 4.4 + systemd) — recommended
  systemd   Plain systemd .service file (podman or docker + systemd)
  openrc    Alpine OpenRC init script (podman or docker + OpenRC)

For all methods a service.env file is copied from config/service.env.example
into the data directory. Edit that file to set LLS_DISCOVERY_SEEDS and other
runtime options, then restart the service.

Logs:
  journalctl -u lightinator-log-service -f       (systemd / quadlet)
  rc-service lightinator-log-service status       (openrc)
USAGE
  exit 0
}

# ── main ──────────────────────────────────────────────────────────────────────
main() {
  [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] && usage || true

  printf '\n  \033[1mLightinator Log Service — Installer\033[0m\n'
  printf '  image: %s\n\n' "$IMAGE"

  # ── discover available methods ──
  _methods=""
  if podman_quadlet && has_systemd; then
    _methods="${_methods}quadlet "
  fi
  if { has podman || has docker; } && has_systemd; then
    _methods="${_methods}systemd "
  fi
  if { has podman || has docker; } && has_openrc; then
    _methods="${_methods}openrc "
  fi

  [ -n "$_methods" ] \
    || die "No supported install method found. Need podman/docker with systemd or OpenRC."

  # ── select method ──
  _count=$(printf '%s\n' $_methods | wc -w)
  method=""

  if [ "$_count" -eq 1 ]; then
    method=$(printf '%s' "$_methods" | tr -d ' ')
    info "Only install method available: $method"
  else
    printf '  \033[0;34m?\033[0m  Install method:\n'
    _i=1
    for _m in $_methods; do
      case "$_m" in
        quadlet) _lbl="Podman Quadlet  (podman >= 4.4 + systemd)  — recommended" ;;
        systemd) _lbl="Systemd unit    (podman or docker + systemd)" ;;
        openrc)  _lbl="Alpine OpenRC   (podman or docker + OpenRC)" ;;
      esac
      printf '    %d) %s\n' "$_i" "$_lbl"
      _i=$((_i + 1))
    done
    printf '    Choice [1]: '
    read -r _pick 2>/dev/null || _pick=1
    _pick="${_pick:-1}"
    _i=1
    for _m in $_methods; do
      if [ "$_i" -eq "$_pick" ]; then method="$_m"; break; fi
      _i=$((_i + 1))
    done
    [ -n "$method" ] || die "Invalid selection."
  fi

  # ── scope (quadlet / systemd only) ──
  case "$method" in
    quadlet|systemd)
      ask_scope
      ;;
    openrc)
      scope=system
      ;;
  esac

  # ── dispatch ──
  case "$method" in
    quadlet) do_quadlet "$scope" ;;
    systemd) do_systemd "$scope" ;;
    openrc)  do_openrc ;;
  esac

  printf '\n'
  info "Installation complete."
  printf '  Web UI: \033[4mhttp://localhost:4821\033[0m\n\n'
}

main "$@"
