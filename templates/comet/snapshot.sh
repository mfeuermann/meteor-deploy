# Copies the current start.sh / env.list to config/.prev (keeps permissions).
CONFIG_DIR=<%- q(configDir) %>
if [ ! -f "$CONFIG_DIR/start.sh" ]; then
  echo "none"
  exit 0
fi
set -e
rm -rf "$CONFIG_DIR/.prev"
mkdir "$CONFIG_DIR/.prev"
chmod 700 "$CONFIG_DIR/.prev"
cp -p "$CONFIG_DIR/start.sh" "$CONFIG_DIR/.prev/start.sh"
if [ -f "$CONFIG_DIR/env.list" ]; then cp -p "$CONFIG_DIR/env.list" "$CONFIG_DIR/.prev/env.list"; fi
echo "ok"
