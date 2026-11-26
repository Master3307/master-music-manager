#!/usr/bin/env bash
# Master Music Manager installer.
#
#   curl -fsSL https://mm-install.master3307.org | bash
#   curl -fsSL https://raw.githubusercontent.com/Master3307/master-music-manager/master/install.sh | bash
#
# Options (after `bash -s --`):
#   --dir <path>     where to install        (root: /opt/master-music-manager, else ~/.local/share/master-music-manager/app)
#   --port <n>       web port                (4545)
#   --no-service     don't start it with the computer
#   --no-extras      skip spotDL, yt-dlp, Chromaprint and archive tools
#   --branch <b>     git branch              (master)
#   --yes            no questions
#   --uninstall      remove the app (your music and the data folder stay)
set -Eeuo pipefail

REPO="https://github.com/Master3307/master-music-manager.git"
BRANCH="master"
PORT=""
SERVICE=1
EXTRAS=1
YES=0
UNINSTALL=0
if [ "$(id -u)" -eq 0 ]; then DIR="/opt/master-music-manager"; else DIR="${XDG_DATA_HOME:-$HOME/.local/share}/master-music-manager/app"; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    --no-extras) EXTRAS=0; shift ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

purple=$'\e[35m'; bold=$'\e[1m'; dim=$'\e[2m'; red=$'\e[31m'; green=$'\e[32m'; off=$'\e[0m'
step() { printf '\n%s◉%s %s%s%s\n' "$purple" "$off" "$bold" "$*" "$off"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n%s✗ %s%s\n' "$red" "$*" "$off" >&2; exit 1; }
trap 'fail "Something went wrong on line $LINENO. Run it again, or open an issue with the output above."' ERR

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else SUDO=""; fi
fi
as_root() { if [ -n "$SUDO" ]; then $SUDO "$@"; elif [ "$(id -u)" -eq 0 ]; then "$@"; else return 1; fi; }

if [ "$UNINSTALL" -eq 1 ]; then
  step "Removing Master Music Manager"
  if [ -f /etc/systemd/system/master-music-manager.service ]; then as_root systemctl disable --now master-music-manager || true; as_root rm -f /etc/systemd/system/master-music-manager.service; as_root systemctl daemon-reload || true; fi
  if [ -f "$HOME/.config/systemd/user/master-music-manager.service" ]; then systemctl --user disable --now master-music-manager || true; rm -f "$HOME/.config/systemd/user/master-music-manager.service"; fi
  as_root rm -f /usr/local/bin/mmm || rm -f "$HOME/.local/bin/mmm" || true
  rm -rf "$DIR"
  info "Removed $DIR. Your music and the data folder were not touched."
  exit 0
fi

printf '%s\n' "${purple}${bold}Master Music Manager${off} ${dim}installer${off}"

# ---- system packages ----
step "Checking what's needed"
PM=""
for p in apt-get dnf pacman zypper apk brew; do command -v "$p" >/dev/null 2>&1 && { PM="$p"; break; }; done
pkg() {
  case "$PM" in
    apt-get) as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null ;;
    dnf) as_root dnf install -y -q "$@" >/dev/null ;;
    pacman) as_root pacman -S --noconfirm --needed "$@" >/dev/null ;;
    zypper) as_root zypper -q install -y "$@" >/dev/null ;;
    apk) as_root apk add -q "$@" >/dev/null ;;
    brew) brew install "$@" >/dev/null ;;
    *) return 1 ;;
  esac
}
[ "$PM" = "apt-get" ] && as_root apt-get update -qq >/dev/null || true

need=()
command -v git >/dev/null || need+=(git)
command -v curl >/dev/null || need+=(curl)
command -v ffmpeg >/dev/null || need+=(ffmpeg)
command -v zip >/dev/null || need+=(zip)
if [ ${#need[@]} -gt 0 ]; then
  info "Installing ${need[*]}"
  pkg "${need[@]}" || fail "Couldn't install ${need[*]}. Install them yourself and run this again."
fi

node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
if ! node_ok; then
  info "Installing Node.js 22"
  case "$PM" in
    apt-get) curl -fsSL https://deb.nodesource.com/setup_22.x | as_root bash - >/dev/null && pkg nodejs ;;
    dnf) curl -fsSL https://rpm.nodesource.com/setup_22.x | as_root bash - >/dev/null && pkg nodejs ;;
    pacman) pkg nodejs npm ;;
    apk) pkg nodejs npm ;;
    brew) pkg node@22 ;;
    *) fail "Please install Node.js 22 or newer (https://nodejs.org) and run this again." ;;
  esac
  node_ok || fail "Node.js 22+ is still missing."
fi
info "Node $(node -v)"

if ! command -v pnpm >/dev/null; then
  info "Installing pnpm"
  if command -v corepack >/dev/null; then as_root corepack enable >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || true; fi
  command -v pnpm >/dev/null || as_root npm install -g pnpm@10 >/dev/null 2>&1 || npm install -g --prefix "$HOME/.local" pnpm@10 >/dev/null
  export PATH="$HOME/.local/bin:$PATH"
fi

if [ "$EXTRAS" -eq 1 ]; then
  info "Extras for archives, recognition and downloads"
  case "$PM" in
    apt-get) pkg libarchive-tools p7zip-full libchromaprint-tools python3-venv pipx || true ;;
    dnf) pkg bsdtar p7zip chromaprint-tools pipx || true ;;
    pacman) pkg libarchive 7zip chromaprint python-pipx || true ;;
    *) true ;;
  esac
  if command -v pipx >/dev/null && ! command -v spotdl >/dev/null; then pipx install spotdl >/dev/null 2>&1 && info "spotDL installed" || info "${dim}spotDL can be installed later in the app (Add → Tools)${off}"; fi
fi

# ---- the app ----
step "Getting Master Music Manager"
if [ -d "$DIR/.git" ]; then
  info "Updating $DIR"
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  mkdir -p "$(dirname "$DIR")"
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"
info "Installing its parts (this takes a minute)"
pnpm install --frozen-lockfile --reporter=silent
pnpm build >/dev/null
info "Version $(node -p 'require("./package.json").version')"

# ---- settings + service ----
step "Setting it up"
[ -n "$PORT" ] && export MMM_PORT="$PORT"
if [ "$SERVICE" -eq 0 ]; then
  node scripts/setup.mjs --yes --no-service </dev/null | sed 's/^/  /' || true
else
  # An update: restart the running service instead of setting it up again.
  if systemctl is-active --quiet master-music-manager 2>/dev/null; then as_root systemctl restart master-music-manager; info "Restarted the service"
  elif systemctl --user is-active --quiet master-music-manager 2>/dev/null; then systemctl --user restart master-music-manager; info "Restarted the service"
  else node scripts/setup.mjs --yes </dev/null | sed 's/^/  /' || true
  fi
fi

# The `mmm` command.
if as_root ln -sf "$DIR/scripts/mmm.mjs" /usr/local/bin/mmm 2>/dev/null; then :; else mkdir -p "$HOME/.local/bin" && ln -sf "$DIR/scripts/mmm.mjs" "$HOME/.local/bin/mmm"; fi
chmod +x "$DIR/scripts/mmm.mjs"

PORT_USED=$(sed -n 's/^MMM_PORT=//p' .env 2>/dev/null | head -1); PORT_USED=${PORT_USED:-4545}
IPS=$(hostname -I 2>/dev/null || true)
printf '\n%s✓ Installed.%s Open one of these in your browser to finish the setup:\n' "$green$bold" "$off"
printf '  %shttp://localhost:%s%s\n' "$purple" "$PORT_USED" "$off"
for ip in $IPS; do case "$ip" in *:*) ;; *) printf '  %shttp://%s:%s%s\n' "$purple" "$ip" "$PORT_USED" "$off" ;; esac; done
printf '\n  %smmm status · mmm update · mmm logs · mmm help%s\n\n' "$dim" "$off"
