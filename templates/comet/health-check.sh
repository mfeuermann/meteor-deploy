# Polls the app until it answers with an allowed HTTP status, crashes or runs out of time.
# Unlike MUP's meteor-deploy-check.sh it accepts only statuses up to MAX_STATUS and never
# reverts anything itself: it reports, and the caller decides. It exits 0 in every case.
# The last line is the machine-readable result (parsed by parseHealthResult):
#   COMET_HEALTH ok <status> <seconds> | COMET_HEALTH fail <reason> <lastStatus|-> <seconds>
CONTAINER=<%- q(container) %>
# PORT, MAX_STATUS and TIMEOUT go in unquoted: healthCheckScript only lets integers through.
PORT=<%- port %>
HC_PATH=<%- q(path) %>
MAX_STATUS=<%- maxStatus %>
TIMEOUT=<%- timeoutSec %>
MAX_NO_IP=10

START=$(date +%s)
END=$((START + TIMEOUT))
NO_IP=0
LAST=-

# Same host-network detection as MUP's meteor-deploy-check.sh (which keeps grep's exit
# status, so there 0 means host network; here it is 1).
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

  # Docker reports restarting only after the app process exited, so a crash loop fails here
  # at once instead of running into the timeout.
  STATE=$(sudo docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  case "$STATE" in
    exited|restarting|dead|missing)
      echo "Container state: $STATE"
      echo "COMET_HEALTH fail crashed $LAST $((NOW - START))"
      exit 0
      ;;
  esac

  # Read the IP on every round: a restarted container can get a new one. Like MUP, try the
  # bridge network first, then the first address on any other network.
  if [ "$HOST_NETWORK" = 1 ]; then
    IP=localhost
  else
    IP=$(sudo docker inspect --format '{{ .NetworkSettings.IPAddress }}' "$CONTAINER" 2>/dev/null)
    if [ -z "$IP" ]; then
      IP=$(sudo docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}
{{end}}' "$CONTAINER" 2>/dev/null | head -n 1)
    fi
  fi

  # Like MUP: no IP for MAX_NO_IP rounds means the container keeps restarting.
  if [ -z "$IP" ]; then
    NO_IP=$((NO_IP + 1))
    if [ "$NO_IP" -ge "$MAX_NO_IP" ]; then
      echo "COMET_HEALTH fail no-ip $LAST $((NOW - START))"
      exit 0
    fi
    sleep 1
    continue
  fi

  # --insecure as in MUP, so a TLS setup cannot fail the check. Without any response curl
  # prints 000 and exits non-zero, which here only means "not up yet".
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
