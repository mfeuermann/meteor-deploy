# mongo-status.sh: what `mongo status` shows, as key=value lines (parsed by parseMongoStatus in
# src/mongo/status.ts). JSON values are base64 on one line. It never fails: without a container
# the values are empty.
DIR=/opt/mongodb

b64() { base64 | tr -d '\n'; }

echo "inspect=$(sudo docker inspect mongodb --format '{{json .}}' 2>/dev/null | b64)"

if [ "$(sudo docker inspect -f '{{.State.Running}}' mongodb 2>/dev/null)" = "true" ]; then
  # The shell of the running image, chosen as in mongo-state.sh.
  CURRENT=
  if sudo test -f $DIR/mongo-start-current.sh; then CURRENT=$(sudo sed -n 's/^MONGO_VERSION=//p' $DIR/mongo-start-current.sh | head -n 1); fi
  SHELL_CMD=mongo
  if [ "${CURRENT%%.*}" -gt 5 ] 2>/dev/null; then SHELL_CMD=mongosh; fi
  T=
  if command -v timeout >/dev/null 2>&1; then T="timeout 20"; fi
  # MUP reads version, connections.current and storageEngine.name from serverStatus.
  echo "server_status=$($T sudo docker exec mongodb $SHELL_CMD --quiet --eval 'var s = db.runCommand({serverStatus: 1, metrics: 0}); JSON.stringify({version: s.version, connections: s.connections, storageEngine: s.storageEngine})' 2>/dev/null | b64)"
  FCV=$($T sudo docker exec mongodb $SHELL_CMD --quiet --eval 'JSON.stringify(db.adminCommand({getParameter: 1, featureCompatibilityVersion: 1}))' 2>/dev/null \
    | sed -n 's/.*"featureCompatibilityVersion":{\{0,1\}\("version":\)\{0,1\}"\([0-9.]*\)".*/\2/p' | head -n 1)
  echo "fcv=$FCV"
fi
