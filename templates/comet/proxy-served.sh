# proxy-served.sh: the certificate nginx serves for each domain of the app, one key=value per
# line (parseServedOutput in src/proxy/served.ts). served.<i> is the leaf certificate as base64
# PEM ("-" = none, "noopenssl", "nohttps"); vhost.<i> and le.<i> say whether a running
# container of the app on this server names the domain in VIRTUAL_HOST or LETSENCRYPT_HOST.
# Domain keys are the index of the domain in proxy.domains. Included by proxy-status.sh.
SERVED_APP=<%- q(appName) %>
SERVED_PORT=$(sudo docker port mup-nginx-proxy 443/tcp 2>/dev/null | head -n 1)
SERVED_PORT=${SERVED_PORT##*:}
SERVED_ENV=$(for n in "$SERVED_APP" "mup-proxy-configure-$SERVED_APP"; do
  if [ "$(sudo docker inspect -f '{{.State.Running}}' "$n" 2>/dev/null)" = true ]; then
    sudo docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$n" 2>/dev/null
  fi
done)
# served_has VAR DOMAIN: 1 when DOMAIN is an item of the comma-separated value of a VAR= line.
served_has() {
  if printf '%s\n' "$SERVED_ENV" | sed -n "s/^$1=//p" | tr ',' '\n' | grep -qxF "$2"; then echo 1; else echo 0; fi
}
<% domains.forEach(function (domain, i) { -%>
SERVED_DOMAIN=<%- q(domain) %>
if [ -z "$SERVED_PORT" ]; then
  echo "served.<%= i %>=nohttps"
elif ! command -v openssl > /dev/null 2>&1; then
  echo "served.<%= i %>=noopenssl"
else
  SERVED_CERT=$(timeout 5 openssl s_client -connect 127.0.0.1:"$SERVED_PORT" -servername "$SERVED_DOMAIN" < /dev/null 2> /dev/null \
    | sed -n '/-BEGIN CERTIFICATE-/,/-END CERTIFICATE-/p' | sed '/-END CERTIFICATE-/q' | base64 -w0)
  echo "served.<%= i %>=${SERVED_CERT:--}"
fi
echo "vhost.<%= i %>=$(served_has VIRTUAL_HOST "$SERVED_DOMAIN")"
echo "le.<%= i %>=$(served_has LETSENCRYPT_HOST "$SERVED_DOMAIN")"
<% }) -%>
