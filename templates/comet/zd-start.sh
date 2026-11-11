# zd-start.sh: starts the next container beside the running app (zero-downtime switch behind the
# proxy): the image housekeeping of MUP's meteor-start.sh, then start.sh without its "remove the
# old container" block and with the name <app>-next (nextContainerScript, base64 on one line).
set -e
cd <%- q(appDir) %>
IMAGE=<%- q(image) %>
# meteor-start.sh's image branch: comet-deploy always runs the distributed image.
sudo rm -rf current || true
if sudo docker image inspect $IMAGE:previous >/dev/null 2>&1; then
  sudo rm -rf last
fi
echo <%- q(script64) %> | base64 -d | sudo bash -s
