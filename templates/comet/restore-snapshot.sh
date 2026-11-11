# Puts the start.sh / env.list saved by snapshot.sh back (undoes a failed activation).
# Prints ok, or none when there is no snapshot. A snapshot without env.list leaves the
# current env.list in place.
CONFIG_DIR=<%- q(configDir) %>
if [ ! -f "$CONFIG_DIR/.prev/start.sh" ]; then
  echo "none"
  exit 0
fi
set -e
cp -p "$CONFIG_DIR/.prev/start.sh" "$CONFIG_DIR/start.sh"
if [ -f "$CONFIG_DIR/.prev/env.list" ]; then cp -p "$CONFIG_DIR/.prev/env.list" "$CONFIG_DIR/env.list"; fi
echo "ok"
