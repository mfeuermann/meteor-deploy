# Moves the :latest / :previous tags of REPO (modes: activate, swap, restore). Prints
# one result word last; activate and swap first print the image IDs the two tags named
# before (before-latest=..., before-previous=...), so the caller can undo the change.
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
PREVIOUS_ID=$(image_id "$REPO:previous")
# Keep the real previous version when the same image is activated again.
if [ -n "$LATEST_ID" ] && [ "$LATEST_ID" != "$NEW_ID" ]; then
  sudo docker tag "$REPO:latest" "$REPO:previous"
fi
# :latest moves last: when anything above fails, the running image still has it.
if ! sudo docker tag "$REPO:$VERSION" "$REPO:latest"; then
  # Put :previous back too, so a failed activation leaves both tags as they were (the caller
  # reports such a server as not changed).
  if [ -n "$PREVIOUS_ID" ]; then
    sudo docker tag "$PREVIOUS_ID" "$REPO:previous" || true
  else
    sudo docker rmi "$REPO:previous" >/dev/null 2>&1 || true
  fi
  exit 1
fi
echo "activated"
<% } else if (mode === 'swap') { %>
# Rollback to :previous: latest <-> previous, so the current image keeps a tag.
if [ -z "$(image_id "$REPO:previous")" ]; then
  echo "no-previous"
  exit 0
fi
# Two tags cannot be swapped in one step, so a temporary tag holds the current image.
if [ -n "$(image_id "$REPO:latest")" ]; then
  sudo docker tag "$REPO:latest" "$REPO:comet-swap"
  sudo docker tag "$REPO:previous" "$REPO:latest"
  sudo docker tag "$REPO:comet-swap" "$REPO:previous"
  # The swap is done; a leftover temporary tag is overwritten by the next swap and removed by destroy.
  sudo docker rmi "$REPO:comet-swap" >/dev/null 2>&1 || true
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
  # There was no :previous before; the image it names now is :latest again, so only the tag
  # goes away.
  sudo docker rmi "$REPO:previous" >/dev/null 2>&1 || true
fi
echo "restored"
<% } %>
