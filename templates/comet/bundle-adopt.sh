# bundle-adopt.sh: takes over a server MUP last deployed in bundle mode (bundle mode design §4.5).
# MUP's meteor-start.sh removed mup-<app>:latest and :previous there: the app container runs the
# base image with /opt/<app>/current mounted at /bundle, and that version exists only as
# current/bundle.tar.gz. This turns it into an image like the ones comet-deploy builds in bundle
# mode (the container's image plus /bundle/bundle.tar.gz, label comet-deploy.bundle=1), tagged
# :latest, so the activation that follows makes it :previous and a rollback can return to it.
# Also tagged :mup-bundle: MUP's next bundle-mode deploy runs `docker rmi :latest`, which Docker
# refuses for the last tag of an image a container runs, and MUP would then go on running this
# image. The running app is not touched. Prints adopted when it took over.
APP_DIR=<%- q(appDir) %>
CONTAINER=<%- q(container) %>
REPO=<%- q(repo) %>
SOURCE=$(sudo docker inspect -f '{{range .Mounts}}{{if eq .Destination "/bundle"}}{{.Source}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null) || exit 0
[ "$SOURCE" = "$APP_DIR/current" ] || exit 0
sudo test -f "$APP_DIR/current/bundle.tar.gz" || exit 0
IMAGE_ID=$(sudo docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null) || exit 0
[ -n "$IMAGE_ID" ] || exit 0
# docker commit leaves the content of a volume out: with /bundle (or /) as a VOLUME of the image
# the taken-over image would have no bundle. Stop before anything changes.
for VOLUME in $(sudo docker image inspect -f '{{range $k, $v := .Config.Volumes}}{{$k}} {{end}}' "$IMAGE_ID" 2>/dev/null || true); do
  case "$VOLUME" in
    / | /bundle | /bundle/)
      echo "The image of the container $CONTAINER declares $VOLUME as a volume, so the bundle MUP mounts cannot be made part of an image: docker commit leaves volumes out. Deploy this app with MUP, or switch it to a base image without that VOLUME." >&2
      exit 1 ;;
  esac
done

set -eo pipefail
WORK="$APP_DIR/tmp/comet-bundle-adopt"
TMP=
cleanup() {
  if [ -n "$TMP" ]; then sudo docker rm -f "$TMP" >/dev/null 2>&1 || true; fi
  sudo rm -rf "$WORK" || true
}
trap cleanup EXIT
# The layer as comet-deploy builds it: bundle/ root:root 755, bundle.tar.gz root:root 644 (the
# tar stream carries owner and mode, docker cp applies them).
sudo rm -rf "$WORK"
sudo mkdir -p "$WORK/bundle"
sudo cp "$APP_DIR/current/bundle.tar.gz" "$WORK/bundle/bundle.tar.gz"
sudo chown -R 0:0 "$WORK/bundle"
sudo chmod 755 "$WORK/bundle"
sudo chmod 644 "$WORK/bundle/bundle.tar.gz"
OLD=$(sudo docker image inspect -f '{{.Id}}' "$REPO:mup-bundle" 2>/dev/null || true)
TMP=$(sudo docker create "$IMAGE_ID")
sudo tar -C "$WORK" --numeric-owner -cf - bundle | sudo docker cp - "$TMP:/"
sudo docker commit --change 'LABEL comet-deploy.bundle=1' "$TMP" "$REPO:latest" >/dev/null
sudo docker tag "$REPO:latest" "$REPO:mup-bundle"
# The version taken over before: removed once nothing refers to it (no tag, no container);
# Docker refuses otherwise, which is fine.
NEW=$(sudo docker image inspect -f '{{.Id}}' "$REPO:latest")
if [ -n "$OLD" ] && [ "$OLD" != "$NEW" ]; then
  sudo docker rmi "$OLD" >/dev/null 2>&1 || true
fi
echo "adopted"
