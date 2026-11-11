# The shared proxy's status for "proxy status", one key=value per line (parseProxyStatus in
# src/proxy/setup.ts): container states, published ports, certificate expiry (MUP's check of
# mounted-certs/*.chain.pem) and the app's upstream file (base64, "-" = missing).
APPNAME=<%- q(appName) %>
state() {
  S=$(sudo docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null)
  echo "${S:-Stopped}"
}
echo "nginx=$(state mup-nginx-proxy)"
echo "le=$(state mup-nginx-proxy-letsencrypt)"
P=$(sudo docker port mup-nginx-proxy 80/tcp 2>/dev/null | head -n 1)
if [ -n "$P" ]; then echo "http=${P##*:}"; fi
P=$(sudo docker port mup-nginx-proxy 443/tcp 2>/dev/null | head -n 1)
if [ -n "$P" ]; then echo "https=${P##*:}"; fi
if cd /opt/mup-nginx-proxy/mounted-certs 2>/dev/null; then
  sudo find . -name '*.chain.pem' | while read -r f; do
    echo "cert=${f#./} $(sudo openssl x509 -enddate -noout -in "$f" 2>/dev/null | cut -d= -f2)"
  done
fi
U=/opt/mup-nginx-proxy/upstream/$APPNAME
if sudo test -f "$U"; then echo "upstream=$(sudo base64 -w0 "$U")"; else echo "upstream=-"; fi
