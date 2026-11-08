# comet-deploy extras on top of MUP's meteor-destroy.sh: version tags, history, lock, snapshot.
REPO=<%- q(repo) %>
CONFIG_DIR=<%- q(configDir) %>
for tag in $(sudo docker images --format '{{.Tag}}' "$REPO" 2>/dev/null | grep -E '^[0-9]{8}-[0-9]{6}(-[0-9a-f]{7})?(-dirty)?$'); do
  sudo docker rmi --force "$REPO:$tag" >/dev/null 2>&1 || true
done
sudo rm -rf "$CONFIG_DIR/deploy-history.jsonl" "$CONFIG_DIR/deploy.lock" "$CONFIG_DIR/.prev"
