# One key=value per line (parsed by parseStatus): docker, container, image (repeated), lock, http.
CONTAINER=<%- q(container) %>
REPO=<%- q(repo) %>
LOCK_DIR=<%- q(lockDir) %>
# PORT is a number, so it goes in unquoted.
PORT=<%- port %>
HC_PATH=<%- q(path) %>

if ! command -v docker >/dev/null 2>&1; then
  echo "docker=not-installed"
  STATE=missing
else
  V=$(sudo docker version --format '{{.Server.Version}}' 2>/dev/null || true)
  if [ -z "$V" ]; then echo "docker=not-running"; else echo "docker=$V"; fi
  STATE=$(sudo docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  sudo docker images --format 'image={{.Tag}} {{.ID}}' "$REPO" 2>/dev/null || true
fi
echo "container=$STATE"

if [ -d "$LOCK_DIR" ]; then
  # info.json joined into one line, to fit the key=value format.
  echo "lock=$(tr -d '\n' < "$LOCK_DIR/info.json" 2>/dev/null)"
fi

# The same container IP lookup as health-check.sh; one quick request, no polling.
if [ "$STATE" = running ]; then
  if sudo docker inspect "$CONTAINER" --format "{{(index .NetworkSettings.Networks)}}" 2>/dev/null | grep -q '\[host'; then
    IP=localhost
  else
    IP=$(sudo docker inspect --format '{{ .NetworkSettings.IPAddress }}' "$CONTAINER" 2>/dev/null)
    if [ -z "$IP" ]; then
      IP=$(sudo docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}
{{end}}' "$CONTAINER" 2>/dev/null | head -n 1)
    fi
  fi
  if [ -n "$IP" ]; then
    echo "http=$(curl --max-time 5 --insecure --silent -o /dev/null -w '%{http_code}' "http://$IP:$PORT$HC_PATH" 2>/dev/null || true)"
  fi
fi
