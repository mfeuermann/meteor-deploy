# Takes over a server whose start.sh MUP wrote with privateDockerRegistry: that start.sh runs
# <prefix>/mup-<app>:latest pulled from the registry, so mup-<app>:latest is missing or an
# older version. Tags mup-<app>:latest to the image the app container runs (or last ran), so
# the activation that follows makes it :previous and a rollback can return to it. The running
# app is not touched. Prints adopted when it tagged.
START_SH=<%- q(startSh) %>
CONTAINER=<%- q(container) %>
REPO=<%- q(repo) %>
if ! sudo grep -qE <%- q(pattern) %> "$START_SH" 2>/dev/null; then
  exit 0
fi
IMAGE_ID=$(sudo docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null) || exit 0
[ -n "$IMAGE_ID" ] || exit 0
set -e
sudo docker tag "$IMAGE_ID" "$REPO:latest"
echo "adopted"
