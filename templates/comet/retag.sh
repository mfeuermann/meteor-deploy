set -e
REPO=<%- q(repo) %>
image_id() { sudo docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }
<% if (mode === 'activate' || mode === 'swap') { %>
# What ran before, so a failed activation can re-tag exactly these images.
echo "before-latest=$(image_id "$REPO:latest")"
echo "before-previous=$(image_id "$REPO:previous")"
<% } %>
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
<% } else if (mode === 'swap') { %>
# Rollback to :previous: latest <-> previous, so the current image keeps a tag.
if [ -z "$(image_id "$REPO:previous")" ]; then
  echo "no-previous"
  exit 0
fi
if [ -n "$(image_id "$REPO:latest")" ]; then
  sudo docker tag "$REPO:latest" "$REPO:comet-swap"
  sudo docker tag "$REPO:previous" "$REPO:latest"
  sudo docker tag "$REPO:comet-swap" "$REPO:previous"
  sudo docker rmi "$REPO:comet-swap" >/dev/null
else
  sudo docker tag "$REPO:previous" "$REPO:latest"
fi
echo "swapped"
<% } else if (mode === 'restore') { %>
# Puts :latest / :previous back on the images they named before the activation.
LATEST_ID=<%- q(latestId) %>
PREVIOUS_ID=<%- q(previousId) %>
sudo docker tag "$LATEST_ID" "$REPO:latest"
if [ -n "$PREVIOUS_ID" ]; then
  sudo docker tag "$PREVIOUS_ID" "$REPO:previous"
else
  sudo docker rmi "$REPO:previous" >/dev/null 2>&1 || true
fi
echo "restored"
<% } else { %>
if [ -n "$(image_id "$REPO:previous")" ]; then
  sudo docker tag "$REPO:previous" "$REPO:latest"
  echo "reverted"
else
  echo "no-previous"
fi
<% } %>
