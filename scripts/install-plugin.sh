#!/usr/bin/env bash
# Installs the Master Music Manager plugin into Navidrome, on any Linux machine:
# Navidrome as a service, a plain binary, or in Docker. It finds Navidrome's
# config, user and plugin folder by itself, then installs, configures and
# enables the plugin. Run it on the machine where Navidrome runs.
#
#   curl -fsSL https://raw.githubusercontent.com/Master3307/master-music-manager/master/scripts/install-plugin.sh \
#     | sudo bash -s -- --url http://<master-music-manager>:4545 --secret <secret>
#
# Options:
#   --url <address>      where Navidrome reaches Master Music Manager
#   --secret <secret>    from Master Music Manager → Settings → Navidrome plugin
#   --no-history         don't copy Navidrome's old listening history
#   --file <plugin.ndp>  use this file instead of downloading the newest one
#   --container <name>   the Navidrome Docker container (found by itself)
#   --config <file>      Navidrome's config file (found by itself)
#   --plugins <folder>   Navidrome's plugin folder (found by itself)
#   --user <name>        the user Navidrome runs as (found by itself)
# Without --url and --secret it only installs the file.
set -euo pipefail

REPO="Master3307/master-music-manager"
URL="" SECRET="" HISTORY=true FILE="" CONTAINER="" CONFIG="" PLUGINS="" NDUSER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift 2 ;;
    --secret) SECRET="$2"; shift 2 ;;
    --no-history) HISTORY=false; shift ;;
    --file) FILE="$2"; shift 2 ;;
    --container) CONTAINER="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --plugins) PLUGINS="$2"; shift 2 ;;
    --user) NDUSER="$2"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then b=$'\e[1m' dim=$'\e[2m' ok=$'\e[32m' red=$'\e[31m' acc=$'\e[35m' off=$'\e[0m'; else b='' dim='' ok='' red='' acc='' off=''; fi
say() { printf '  %s\n' "$*"; }
step() { printf '%s›%s %s\n' "$acc" "$off" "$*"; }
die() { printf '%s✗ %s%s\n' "$red" "$*" "$off" >&2; exit 1; }
[ -n "$URL" ] && [ -z "$SECRET" ] && die "--url needs --secret too (make one in Master Music Manager → Settings → Navidrome plugin)"
[ -n "$SECRET" ] && [ -z "$URL" ] && die "--secret needs --url too (the address Navidrome uses to reach Master Music Manager)"
need() { command -v "$1" >/dev/null 2>&1 || die "This needs '$1'. Install it and run this again."; }
need curl

# Setting from a Navidrome TOML file: top-level Key, or Key inside [Section].
toml_get() {
  local file="$1" section="$2" key="$3"
  [ -r "$file" ] || return 0
  awk -v sec="$section" -v key="$key" '
    /^[[:space:]]*\[/ { gsub(/[][[:space:]]/, ""); cur = $0; next }
    {
      line = $0; sub(/#.*/, "", line)
      split(line, kv, "=")
      k = kv[1]; gsub(/[[:space:]]/, "", k)
      want = (sec == "" ? key : key)
      if (cur == sec && tolower(k) == tolower(want)) {
        v = substr(line, index(line, "=") + 1); gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/, "", v); print v; exit
      }
      if (sec != "" && cur == "" && tolower(k) == tolower(sec "." key)) {
        v = substr(line, index(line, "=") + 1); gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/, "", v); print v; exit
      }
    }' "$file"
}

# ── Where is Navidrome? ───────────────────────────────────────────────
MODE="" ND_BIN="" WORKDIR=""
if [ -z "$CONTAINER" ] && command -v docker >/dev/null 2>&1; then
  CONTAINER="$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | awk 'tolower($2) ~ /navidrome/ { print $1; exit }')" || true
fi
if [ -n "$CONTAINER" ]; then
  MODE=docker
  docker inspect "$CONTAINER" >/dev/null 2>&1 || die "No Docker container named '$CONTAINER'."
  ND_BIN="$(docker exec "$CONTAINER" sh -c 'command -v navidrome || ls /app/navidrome 2>/dev/null' | head -1)"
  [ -n "$ND_BIN" ] || die "Navidrome wasn't found inside the container '$CONTAINER'."
  cenv() { docker exec "$CONTAINER" printenv "$1" 2>/dev/null || true; }
  DATA="$(cenv ND_DATAFOLDER)"; DATA="${DATA:-/data}"
  [ -z "$PLUGINS" ] && PLUGINS="$(cenv ND_PLUGINS_FOLDER)"
  PLUGINS="${PLUGINS:-$DATA/plugins}"
  say "Found Navidrome in the Docker container ${b}$CONTAINER${off}"
else
  MODE=native
  unit=""
  if command -v systemctl >/dev/null 2>&1; then
    unit="$(systemctl list-units --type=service --all --no-legend 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^navidrome.*\.service$/) { print $i; exit } }')" || true
  fi
  if [ -n "$unit" ]; then
    exec_line="$(systemctl show -p ExecStart --value "$unit" 2>/dev/null)"
    [ -z "$ND_BIN" ] && ND_BIN="$(printf '%s' "$exec_line" | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"
    argv="$(printf '%s' "$exec_line" | sed -n 's/.*argv\[\]=\([^;]*\).*/\1/p')"
    [ -z "$CONFIG" ] && CONFIG="$(printf '%s\n' "$argv" | tr ' ' '\n' | awk 'p { gsub(/"/, ""); print; exit } /^"?(-c|--configfile)"?$/ { p = 1 } /^"?--configfile=/ { sub(/^"?--configfile=/, ""); gsub(/"/, ""); print; exit }')"
    [ -z "$NDUSER" ] && NDUSER="$(systemctl show -p User --value "$unit" 2>/dev/null)"
    WORKDIR="$(systemctl show -p WorkingDirectory --value "$unit" 2>/dev/null)"
    envs="$(systemctl show -p Environment --value "$unit" 2>/dev/null)"
    for f in $(systemctl show -p EnvironmentFiles --value "$unit" 2>/dev/null | awk '{ print $1 }'); do [ -r "$f" ] && envs="$envs $(grep -E '^[A-Z_]+=' "$f" | tr '\n' ' ')"; done
    uenv() { printf '%s\n' $envs | sed -n "s/^$1=//p" | tr -d '"' | tail -1; }
    [ -z "$CONFIG" ] && CONFIG="$(uenv ND_CONFIGFILE)"
    ENV_DATA="$(uenv ND_DATAFOLDER)"; ENV_PLUGINS="$(uenv ND_PLUGINS_FOLDER)"
    say "Found Navidrome as the service ${b}$unit${off}"
  fi
  [ -z "$ND_BIN" ] && ND_BIN="$(command -v navidrome || true)"
  for p in /usr/bin/navidrome /usr/local/bin/navidrome /opt/navidrome/navidrome; do [ -z "$ND_BIN" ] && [ -x "$p" ] && ND_BIN="$p"; done
  [ -n "$ND_BIN" ] || die "Navidrome wasn't found on this machine. Run this where Navidrome runs (or pass --container for Docker)."
  if [ -n "$CONFIG" ] && [ "${CONFIG#/}" = "$CONFIG" ] && [ -n "$WORKDIR" ]; then CONFIG="$WORKDIR/$CONFIG"; fi
  if [ -z "$CONFIG" ]; then
    for p in /etc/navidrome/navidrome.toml /var/lib/navidrome/navidrome.toml /opt/navidrome/navidrome.toml "${WORKDIR:-/nonexistent}/navidrome.toml" "$(dirname "$ND_BIN")/navidrome.toml"; do
      [ -f "$p" ] && { CONFIG="$p"; break; }
    done
  fi
  DATA="${ENV_DATA:-$(toml_get "$CONFIG" "" DataFolder)}"
  DATA="${DATA:-${WORKDIR:-$(dirname "${CONFIG:-$ND_BIN}")}}"
  [ -z "$PLUGINS" ] && PLUGINS="${ENV_PLUGINS:-$(toml_get "$CONFIG" Plugins Folder)}"
  PLUGINS="${PLUGINS:-$DATA/plugins}"
  [ -z "$NDUSER" ] && [ -d "$DATA" ] && NDUSER="$(stat -c %U "$DATA" 2>/dev/null || true)"
  NDUSER="${NDUSER:-$(id -un)}"
  [ -n "$CONFIG" ] && say "Config: ${dim}$CONFIG${off}"
  say "Plugins: ${dim}$PLUGINS${off}   runs as: ${dim}$NDUSER${off}"
fi

# Run Navidrome's own CLI the way the server runs (same user, config, folders).
nd() {
  if [ "$MODE" = docker ]; then
    docker exec "$CONTAINER" "$ND_BIN" plugin "$@"
    return
  fi
  local cmd=("$ND_BIN")
  [ -n "$CONFIG" ] && cmd+=(-c "$CONFIG")
  cmd+=(--datafolder "$DATA" plugin "$@")
  if [ "$(id -un)" = "$NDUSER" ]; then (cd "$DATA" && "${cmd[@]}")
  elif [ "$(id -u)" = 0 ]; then (cd "$DATA" && runuser -u "$NDUSER" -- "${cmd[@]}")
  elif command -v sudo >/dev/null 2>&1; then (cd "$DATA" && sudo -u "$NDUSER" -- "${cmd[@]}")
  else die "Navidrome runs as '$NDUSER'. Run this with sudo."; fi
}
# Drop Navidrome's ASCII banner (lines of only these characters) and info logs.
quiet() { grep -vE "^[][ _|\\/\`'.,()-]*\$|Version: |level=(info|debug)|No configuration file" || true; }

# ── The plugin file ───────────────────────────────────────────────────
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
if [ -n "$FILE" ]; then
  cp "$FILE" "$tmp/master-music-manager.ndp"
else
  step "Downloading the newest plugin"
  asset="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" | grep -o '"browser_download_url": *"[^"]*master-music-manager\.ndp"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
  [ -n "$asset" ] || die "No plugin release found on GitHub."
  curl -fsSL "$asset" -o "$tmp/master-music-manager.ndp"
fi

step "Installing it into Navidrome"
if [ "$MODE" = docker ]; then
  docker exec "$CONTAINER" mkdir -p "$PLUGINS"
  docker cp "$tmp/master-music-manager.ndp" "$CONTAINER:$PLUGINS/master-music-manager.ndp" >/dev/null
else
  if [ ! -d "$PLUGINS" ]; then mkdir -p "$PLUGINS" 2>/dev/null || sudo mkdir -p "$PLUGINS"; fi
  if [ -w "$PLUGINS" ]; then cp "$tmp/master-music-manager.ndp" "$PLUGINS/"; else sudo cp "$tmp/master-music-manager.ndp" "$PLUGINS/"; fi
  chown "$NDUSER:" "$PLUGINS" "$PLUGINS/master-music-manager.ndp" 2>/dev/null || sudo chown "$NDUSER:" "$PLUGINS" "$PLUGINS/master-music-manager.ndp" 2>/dev/null || true
fi
nd validate "$PLUGINS/master-music-manager.ndp" 2>&1 | quiet | grep -q ': OK$' || die "Navidrome didn't accept the plugin file. Is Navidrome 0.60 or newer?"
nd rescan 2>&1 | quiet >/dev/null
nd list 2>&1 | grep -q '^master-music-manager ' || die "Navidrome doesn't list the plugin. Check that plugins are on (Plugins.Enabled = true in its config)."
say "${ok}✓${off} Installed"

if [ -z "$URL" ]; then
  echo
  say "Now connect it: Master Music Manager → Settings → Navidrome plugin shows the command with your address and secret."
  exit 0
fi

# ── Can Navidrome reach Master Music Manager? ─────────────────────────
step "Checking that Navidrome can reach $URL"
if [ "$MODE" = docker ]; then reach() { docker exec "$CONTAINER" wget -qO- "$1" 2>/dev/null || curl -fsS --max-time 8 "$1"; }; else reach() { curl -fsS --max-time 8 "$1"; }; fi
if reach "$URL/api/health" 2>/dev/null | grep -q '"ok":true'; then say "${ok}✓${off} Reachable"
else say "${red}!${off} $URL doesn't answer from here. The plugin is set up anyway; plays wait until it's reachable."; fi

step "Connecting and enabling it"
cfg="$(printf '{"url":"%s","secret":"%s","syncHistory":%s}' "$URL" "$SECRET" "$HISTORY")"
nd edit master-music-manager --config "$cfg" --all-users 2>&1 | quiet
nd enable master-music-manager 2>&1 | quiet
nd list 2>&1 | awk '$1 == "master-music-manager"' | grep -q true || die "Navidrome didn't enable it. Its log says why (plugin errors are listed there)."
echo
say "${ok}✓ Done.${off} Every play in Navidrome now reaches Master Music Manager. Settings → Navidrome plugin shows when it last heard from it."
