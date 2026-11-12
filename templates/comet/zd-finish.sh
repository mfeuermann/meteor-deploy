# zd-finish.sh: replaces the app with the next container once it is healthy and nginx routes to
# it. First nginx routes only to the next container: a vhost.d/<domain>_upstream file makes MUP's
# template use the servers in it instead of the containers (the mechanism of MUP's load
# balancing), so no regeneration until the old container is gone, also not the one the Let's
# Encrypt companion runs, sends requests to the old container. Its IP disappears the moment it
# stops, and a request nginx sent there would hang until a timeout. Then the old container stops
# (10 s for its in-flight requests) and is removed, the next container gets the app's name, and
# the files are removed again (also when the script ends early or the connection drops), which
# gives the config docker-gen generates from the containers.
set -e
NAME=<%- q(name) %>
NEXT=<%- q(next) %>
PROXYNAME=<%- q(proxyName) %>
VHOST_D=/opt/$PROXYNAME/config/vhost.d
ROUTED=()
regenerate() {
  sudo docker exec $PROXYNAME docker-gen /app/nginx.tmpl /etc/nginx/conf.d/default.conf &&
    sudo docker exec $PROXYNAME nginx -t > /dev/null 2>&1 &&
    sudo docker exec $PROXYNAME nginx -s reload
}
unroute() {
  [ ${#ROUTED[@]} -eq 0 ] && return 0
  for f in "${ROUTED[@]}"; do sudo rm -f "$f"; done
  ROUTED=()
  regenerate || >&2 echo "Regenerating the nginx config failed"
}
trap unroute EXIT
trap 'exit 1' HUP INT TERM
# A domain that already has an upstream file (load balancing) keeps it: that file decides. A file
# with this script's first line is a leftover of a switch that was killed: it is replaced.
MARK='# comet-deploy zero-downtime switch'
<% domains.forEach(function (domain) { -%>
F="$VHOST_D/"<%- q(domain + '_upstream') %>
if [ ! -L "$F" ] && { [ ! -e "$F" ] || [ "$(sudo head -n 1 "$F")" = "$MARK" ]; }; then
  printf '%s\n%s\n' "$MARK" <%- q('server ' + route + ';') %> | sudo tee "$F" > /dev/null
  ROUTED+=("$F")
fi
<% }) -%>
if [ ${#ROUTED[@]} -gt 0 ] && ! regenerate; then
  >&2 echo "Could not route nginx to the new container only; stopping the old one anyway"
fi
if sudo docker inspect "$NAME" >/dev/null 2>&1; then
  sudo docker stop -t 10 "$NAME" >/dev/null || true
  sudo docker rm -f "$NAME" >/dev/null
fi
# MUP's start.sh also removes these containers of old MUP versions.
for c in "$NAME-frontend" "$NAME-nginx-letsencrypt" "$NAME-nginx-proxy"; do
  sudo docker rm -f "$c" >/dev/null 2>&1 || true
done
sudo docker rename "$NEXT" "$NAME"
unroute
echo switched
