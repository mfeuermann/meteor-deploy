# mongo-state.sh: the state of MUP's built-in MongoDB on this server, one key=value per line
# (parsed by parseMongoState in src/mongo/state.ts). It never fails: a missing file or
# container gives empty values.
DIR=/opt/mongodb

version_of() {
  if sudo test -f "$1"; then sudo sed -n 's/^MONGO_VERSION=//p' "$1" | head -n 1; fi
}

if sudo test -f $DIR/mongo-start-new.sh; then echo "set_up=1"; else echo "set_up=0"; fi
CURRENT=$(version_of $DIR/mongo-start-current.sh)
echo "new_version=$(version_of $DIR/mongo-start-new.sh)"
echo "current_version=$CURRENT"
# Whether mongo start would run the current start script unchanged (MUP compares the two files).
if sudo cmp -s $DIR/mongo-start-new.sh $DIR/mongo-start-current.sh 2>/dev/null; then echo "same_script=1"; else echo "same_script=0"; fi
echo "container=$(sudo docker inspect -f '{{.Id}}' mongodb 2>/dev/null)"

if [ "$(sudo docker inspect -f '{{.State.Running}}' mongodb 2>/dev/null)" = "true" ]; then
  echo "running=1"
  # The shell of the running image, by MUP's rule (mongosh above major version 5). A tag that
  # is not a number gives "mongo", as in MUP.
  SHELL_CMD=mongo
  if [ "${CURRENT%%.*}" -gt 5 ] 2>/dev/null; then SHELL_CMD=mongosh; fi
  T=
  if command -v timeout >/dev/null 2>&1; then T="timeout 20"; fi
  # 3.4 answers {"featureCompatibilityVersion":"3.4"}, later versions {"featureCompatibilityVersion":{"version":"6.0"}}.
  FCV=$($T sudo docker exec mongodb $SHELL_CMD --quiet --eval 'JSON.stringify(db.adminCommand({getParameter: 1, featureCompatibilityVersion: 1}))' 2>/dev/null \
    | sed -n 's/.*"featureCompatibilityVersion":{\{0,1\}\("version":\)\{0,1\}"\([0-9.]*\)".*/\2/p' | head -n 1)
  echo "fcv=$FCV"
  # The replica set MUP's start script creates ("meteor"); empty when there is none yet.
  echo "replica_set=$($T sudo docker exec mongodb $SHELL_CMD --quiet --eval 'rs.status().set' 2>/dev/null | tail -n 1)"
else
  echo "running=0"
fi
