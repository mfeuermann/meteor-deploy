# One key=value per line. For the overview (parseStatus): docker, container, image (repeated),
# lock, http. For the full report (parseStatusDetails): os, arch, dockerroot, dockerfree (KiB),
# and for an existing container started, restarts, network, port (repeated), envname
# (repeated), httpurl. The container env goes out by name only: values such as MONGO_URL or
# METEOR_SETTINGS never leave the server.
CONTAINER=<%- q(container) %>
REPO=<%- q(repo) %>
LOCK_DIR=<%- q(lockDir) %>
# PORT is a number, so it goes in unquoted.
PORT=<%- port %>
HC_PATH=<%- q(path) %>

# In a subshell, so os-release's variables stay out of this script.
OS=$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-}")
[ -n "$OS" ] || OS=$(uname -s)
echo "os=$OS"
echo "arch=$(uname -m)"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker=not-installed"
  STATE=missing
else
  V=$(sudo docker version --format '{{.Server.Version}}' 2>/dev/null || true)
  if [ -z "$V" ]; then echo "docker=not-running"; else echo "docker=$V"; fi
  STATE=$(sudo docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  sudo docker images --format 'image={{.Tag}} {{.ID}}' "$REPO" 2>/dev/null || true
  ROOT=$(sudo docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
  if [ -n "$ROOT" ]; then
    echo "dockerroot=$ROOT"
    echo "dockerfree=$(sudo df -Pk "$ROOT" 2>/dev/null | awk 'NR == 2 { print $4 }')"
  fi
fi
echo "container=$STATE"

if [ -d "$LOCK_DIR" ]; then
  # info.json joined into one line, to fit the key=value format.
  echo "lock=$(tr -d '\n' < "$LOCK_DIR/info.json" 2>/dev/null)"
fi

if [ "$STATE" != missing ]; then
  read -r STARTED RESTARTS <<< "$(sudo docker inspect --format '{{.State.StartedAt}} {{.RestartCount}}' "$CONTAINER" 2>/dev/null)"
  echo "started=$STARTED"
  echo "restarts=$RESTARTS"
  sudo docker inspect --format '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}port={{.HostIp}}:{{.HostPort}} -> {{$p}}{{"\n"}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null | grep '^port=' || true
  # The name of each entry, cut off by the template itself: a value with a newline (a key in
  # PEM form) cannot turn into a line of its own. Lines that are no variable name are dropped.
  sudo docker inspect --format '{{range .Config.Env}}{{index (split . "=") 0}}{{"\n"}}{{end}}' "$CONTAINER" 2>/dev/null | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' | sed 's/^/envname=/' || true
fi

# The same container IP lookup as health-check.sh; one quick request, no polling.
if [ "$STATE" != missing ]; then
  if sudo docker inspect --format '{{(index .NetworkSettings.Networks)}}' "$CONTAINER" 2>/dev/null | grep -q '\[host'; then
    echo "network=host"
    IP=localhost
  else
    echo "network=bridge"
    IP=$(sudo docker inspect --format '{{ .NetworkSettings.IPAddress }}' "$CONTAINER" 2>/dev/null)
    if [ -z "$IP" ]; then
      IP=$(sudo docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}
{{end}}' "$CONTAINER" 2>/dev/null | head -n 1)
    fi
  fi
  if [ "$STATE" = running ] && [ -n "$IP" ]; then
    URL="http://$IP:$PORT$HC_PATH"
    echo "httpurl=$URL"
    echo "http=$(curl --max-time 5 --insecure --silent -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null || true)"
  fi
fi
