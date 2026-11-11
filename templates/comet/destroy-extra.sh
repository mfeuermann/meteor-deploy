# comet-deploy extras on top of MUP's meteor-destroy.sh: version tags, history, lock, snapshot.
# Runs after it, so :latest, :previous and /opt/<app> are already gone.
REPO=<%- q(repo) %>
CONFIG_DIR=<%- q(configDir) %>
# The pattern is VERSION_RE in src/build/version.ts; keep the two in sync.
for tag in $(sudo docker images --format '{{.Tag}}' "$REPO" 2>/dev/null | grep -E '^[0-9]{8}-[0-9]{6}(-[0-9a-f]{7})?(-dirty)?$'); do
  sudo docker rmi --force "$REPO:$tag" >/dev/null 2>&1 || true
done
# Left behind only when a rollback swap was interrupted between its tag commands.
sudo docker rmi --force "$REPO:comet-swap" >/dev/null 2>&1 || true
# Normally already removed with /opt/<app>; listed so this script also cleans up on its own.
sudo rm -rf "$CONFIG_DIR/deploy-history.jsonl" "$CONFIG_DIR/deploy.lock" "$CONFIG_DIR/.prev"
