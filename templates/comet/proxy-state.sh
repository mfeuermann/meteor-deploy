# The app's files in the shared proxy, one key=value per line (parsed by parseProxyState in
# src/proxy/sync.ts). File hashes are sha256, "-" = the file is missing. Lists and file contents
# are base64, so names and multi-line content fit on one line. Domain keys are the index of the
# domain in proxy.domains.
APPNAME=<%- q(appName) %>
PROXYNAME=<%- q(proxyName) %>
VHOST=/opt/$PROXYNAME/config/vhost.d

hash() {
  if sudo test -f "$1"; then sudo sha256sum "$1" | cut -d' ' -f1; else echo -; fi
}
content() {
  if sudo test -f "$1"; then sudo base64 -w0 "$1"; else echo -; fi
}

<% domains.forEach(function (domain, i) { -%>
echo "vhost.<%= i %>=$(hash "$VHOST"/<%- q(domain) %>)"
echo "location.<%= i %>=$(hash "$VHOST"/<%- q(domain + '_location') %>)"
<% }) -%>

echo "crt=$(hash /opt/$APPNAME/config/bundle.crt)"
echo "key=$(hash /opt/$APPNAME/config/private.key)"

# Domains whose certs/<domain>.crt is ssl-setup.sh's link to this app's bundle.crt.
echo "certlinks=$(
  cd /opt/$PROXYNAME/certs 2>/dev/null && for f in *.crt; do
    if [ -L "$f" ] && [ "$(readlink "$f")" = "/opt/$APPNAME/config/bundle.crt" ]; then echo "${f%.crt}"; fi
  done | base64 -w0
)"

echo "upstream=$(content /opt/$PROXYNAME/upstream/$APPNAME)"
# Domains whose vhost.d/<domain>_upstream is upstream.sh's link to this app's upstream file.
echo "upstreamlinks=$(
  cd "$VHOST" 2>/dev/null && for f in *_upstream; do
    if [ -L "$f" ] && [ "$(readlink "$f")" = "../upstream/$APPNAME" ]; then echo "${f%_upstream}"; fi
  done | base64 -w0
)"

echo "service=$(content /opt/$APPNAME/config/proxy-config-container.sh)"
if [ "$(sudo docker inspect -f '{{.State.Running}}' mup-proxy-configure-$APPNAME 2>/dev/null)" = true ]; then
  echo "serviceRunning=1"
else
  echo "serviceRunning=0"
fi
if [ "$(sudo docker inspect -f '{{.State.Running}}' $PROXYNAME 2>/dev/null)" = true ]; then
  echo "proxyRunning=1"
else
  echo "proxyRunning=0"
fi
