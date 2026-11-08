set -e
REPO=<%- q(repo) %>
image_id() { sudo docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }
<% if (mode === 'activate') { %>
VERSION=<%- q(version) %>
NEW_ID=$(image_id "$REPO:$VERSION")
if [ -z "$NEW_ID" ]; then
  >&2 echo "Image $REPO:$VERSION is not on this server"
  exit 3
fi
LATEST_ID=$(image_id "$REPO:latest")
# Keep the real previous version when the same image is activated again.
if [ -n "$LATEST_ID" ] && [ "$LATEST_ID" != "$NEW_ID" ]; then
  sudo docker tag "$REPO:latest" "$REPO:previous"
fi
sudo docker tag "$REPO:$VERSION" "$REPO:latest"
echo "activated"
<% } else { %>
if [ -n "$(image_id "$REPO:previous")" ]; then
  sudo docker tag "$REPO:previous" "$REPO:latest"
  echo "reverted"
else
  echo "no-previous"
fi
<% } %>
