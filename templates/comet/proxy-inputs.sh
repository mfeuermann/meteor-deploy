# proxy-inputs.sh: one sha256 over the files the proxy containers are created from (start.sh
# reads them; a missing file counts as "-"), and whether both proxy containers run. Parsed by
# proxyInputsDigest in src/proxy/setup.ts. Nothing is stored on the server.
CONFIG=/opt/mup-nginx-proxy/config
for f in start.sh shared-config.sh env.list env_letsencrypt.list nginx-default.conf nginx.tmpl nginx-shared.tmpl; do
  if sudo test -f "$CONFIG/$f"; then echo "$f $(sudo sha256sum "$CONFIG/$f" | cut -d' ' -f1)"; else echo "$f -"; fi
done | sha256sum | cut -d' ' -f1 | sed 's/^/digest=/'
RUNNING=1
for c in mup-nginx-proxy mup-nginx-proxy-letsencrypt; do
  [ "$(sudo docker inspect -f '{{.State.Running}}' $c 2>/dev/null)" = true ] || RUNNING=0
done
echo "running=$RUNNING"
