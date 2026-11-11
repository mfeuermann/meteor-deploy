# Copies the current start.sh / env.list to config/.prev (keeps permissions) before an
# activation rewrites them, so a failure can restore the config together with the image.
# Prints ok, or none when there is no start.sh yet (first deploy).
CONFIG_DIR=<%- q(configDir) %>
if [ ! -f "$CONFIG_DIR/start.sh" ]; then
  echo "none"
  exit 0
fi
set -e
# Start empty, so no file of an older snapshot survives. The directory is private because
# env.list holds secrets (cp -p also keeps its 600 mode).
rm -rf "$CONFIG_DIR/.prev"
mkdir "$CONFIG_DIR/.prev"
chmod 700 "$CONFIG_DIR/.prev"
cp -p "$CONFIG_DIR/start.sh" "$CONFIG_DIR/.prev/start.sh"
if [ -f "$CONFIG_DIR/env.list" ]; then cp -p "$CONFIG_DIR/env.list" "$CONFIG_DIR/.prev/env.list"; fi
echo "ok"
