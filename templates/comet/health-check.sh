# Polls the app until it answers with an allowed HTTP status (spec §10.2 step 5).
# The last line is the machine-readable result:
#   COMET_HEALTH ok <status> <seconds> | COMET_HEALTH fail <reason> <lastStatus|-> <seconds>
CONTAINER=<%- q(container) %>
PORT=<%- port %>
HC_PATH=<%- q(path) %>
MAX_STATUS=<%- maxStatus %>
TIMEOUT=<%- timeoutSec %>
MAX_NO_IP=10

START=$(date +%s)
END=$((START + TIMEOUT))
NO_IP=0
LAST=-

# Same host-network detection as MUP's meteor-deploy-check.sh.
if sudo docker inspect "$CONTAINER" --format "{{(index .NetworkSettings.Networks)}}" 2>/dev/null | grep -q '\[host'; then
  HOST_NETWORK=1
else
  HOST_NETWORK=0
fi

while true; do
  NOW=$(date +%s)
  if [ "$NOW" -ge "$END" ]; then
    echo "COMET_HEALTH fail timeout $LAST $((NOW - START))"
    exit 0
  fi

  STATE=$(sudo docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  case "$STATE" in
    exited|restarting|dead|missing)
      echo "Container state: $STATE"
      echo "COMET_HEALTH fail crashed $LAST $((NOW - START))"
      exit 0
      ;;
  esac

  if [ "$HOST_NETWORK" = 1 ]; then
    IP=localhost
  else
    IP=$(sudo docker inspect --format '{{ .NetworkSettings.IPAddress }}' "$CONTAINER" 2>/dev/null)
    if [ -z "$IP" ]; then
      IP=$(sudo docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}
{{end}}' "$CONTAINER" 2>/dev/null | head -n 1)
    fi
  fi

  if [ -z "$IP" ]; then
    NO_IP=$((NO_IP + 1))
    if [ "$NO_IP" -ge "$MAX_NO_IP" ]; then
      echo "COMET_HEALTH fail no-ip $LAST $((NOW - START))"
      exit 0
    fi
    sleep 1
    continue
  fi

  CODE=$(curl --max-time 25 --insecure --silent -o /dev/null -w '%{http_code}' "http://$IP:$PORT$HC_PATH" 2>/dev/null || true)
  if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then
    LAST=$CODE
    if [ "$CODE" -le "$MAX_STATUS" ]; then
      echo "COMET_HEALTH ok $CODE $(($(date +%s) - START))"
      exit 0
    fi
  fi
  sleep 1
done
