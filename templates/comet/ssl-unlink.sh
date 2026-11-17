# ssl-unlink.sh: runs between the upload of the custom certificate and ssl-setup.sh (proxy
# certificates spec §4.4). After Let's Encrypt, mounted-certs/<domain>.crt and the files beside
# it are links of the Let's Encrypt companion into its own folder. cp follows a link, so
# ssl-setup.sh would write the certificate into the companion's files and leave the link, and
# the companion deletes its links once no container asks it for the domain: nginx then serves
# the companion's self-signed default. MUP only copies regular files here, so only links go.
for f in<% domains.forEach(function (domain) { ['crt', 'key', 'chain.pem', 'dhparam.pem'].forEach(function (ext) { %> <%- q('/opt/' + proxyName + '/mounted-certs/' + domain + '.' + ext) %><% }) }) %>; do
  if sudo test -L "$f"; then sudo rm -f "$f"; fi
done
