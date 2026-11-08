CONFIG_DIR=<%- q(configDir) %>
if [ ! -f "$CONFIG_DIR/.prev/start.sh" ]; then
  echo "none"
  exit 0
fi
set -e
cp -p "$CONFIG_DIR/.prev/start.sh" "$CONFIG_DIR/start.sh"
if [ -f "$CONFIG_DIR/.prev/env.list" ]; then cp -p "$CONFIG_DIR/.prev/env.list" "$CONFIG_DIR/env.list"; fi
echo "ok"
