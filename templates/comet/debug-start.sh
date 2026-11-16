# debug-start.sh: enables the Node inspector of the app and starts the helper container of
# `meteor debug` (commands design §4.3). Exit 10: the app container does not run; 11: the
# inspector could not be enabled; 12: the helper could not start (reason on stderr). Prints
# network=bridge|host, for bridge ip= and gateway= of the container's first network, and id=.
CONTAINER=<%- q(container) %>
HELPER=<%- q(helper) %>
IMAGE=<%- q(image) %>
# A number, so it goes in unquoted.
LISTEN_PORT=<%- listenPort %>

read -r RUNNING ID <<< "$(sudo docker inspect -f '{{.State.Running}} {{.Id}}' "$CONTAINER" 2>/dev/null)"
[ "$RUNNING" = true ] || exit 10

# SIGUSR1 makes Node open its inspector on 127.0.0.1:9229 inside the container. The PID comes
# from pidof, or from /proc when the image has no pidof.
FIND_AND_SIGNAL='pid=$(pidof -s node 2>/dev/null)
if [ -z "$pid" ]; then
  for d in /proc/[0-9]*; do
    if [ "$(cat "$d/comm" 2>/dev/null)" = node ]; then pid=${d#/proc/}; break; fi
  done
fi
[ -n "$pid" ] || { echo "no node process in the container" >&2; exit 1; }
kill -s USR1 "$pid"'
if ! OUT=$(sudo docker exec "$CONTAINER" sh -c "$FIND_AND_SIGNAL" 2>&1); then
  echo "$OUT" >&2
  exit 11
fi

if sudo docker inspect -f '{{(index .NetworkSettings.Networks)}}' "$CONTAINER" 2>/dev/null | grep -q '\[host'; then
  NETWORK=host
  # Nothing to listen on: the inspector is on the server's own loopback. The helper only gives
  # the docker exec fallback a socat to run.
  HELPER_ARGS=(--network host --entrypoint sleep "$IMAGE" infinity)
else
  NETWORK=bridge
  read -r IP GATEWAY <<< "$(sudo docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.Gateway}}{{"\n"}}{{end}}' "$CONTAINER" 2>/dev/null | head -n 1)"
  if [ -z "$IP" ] || [ -z "$GATEWAY" ]; then
    echo "the app container $CONTAINER has no IP address in a Docker network" >&2
    exit 12
  fi
  # Listens in the app's network namespace. Connections from the server (sshd) to the
  # container's IP come from the gateway address, so range= lets in only the server itself, not
  # the other containers of the network.
  HELPER_ARGS=(--network "container:$CONTAINER" "$IMAGE" "TCP-LISTEN:$LISTEN_PORT,fork,reuseaddr,range=$GATEWAY/32" TCP:127.0.0.1:9229)
fi

sudo docker rm -f "$HELPER" >/dev/null 2>&1 || true
if ! OUT=$(sudo docker run -d --rm --name "$HELPER" "${HELPER_ARGS[@]}" 2>&1); then
  echo "$OUT" >&2
  exit 12
fi

echo "network=$NETWORK"
if [ "$NETWORK" = bridge ]; then
  echo "ip=$IP"
  echo "gateway=$GATEWAY"
fi
echo "id=$ID"
