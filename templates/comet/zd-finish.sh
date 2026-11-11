# zd-finish.sh: replaces the app with the next container once it is healthy and nginx routes to
# it: stops the old container (10 s for its in-flight requests), removes it, and gives the next
# container the app's name. nginx (docker-gen) drops the old container when it stops.
set -e
NAME=<%- q(name) %>
NEXT=<%- q(next) %>
if sudo docker inspect "$NAME" >/dev/null 2>&1; then
  sudo docker stop -t 10 "$NAME" >/dev/null || true
  sudo docker rm -f "$NAME" >/dev/null
fi
# MUP's start.sh also removes these containers of old MUP versions.
for c in "$NAME-frontend" "$NAME-nginx-letsencrypt" "$NAME-nginx-proxy"; do
  sudo docker rm -f "$c" >/dev/null 2>&1 || true
done
sudo docker rename "$NEXT" "$NAME"
echo switched
