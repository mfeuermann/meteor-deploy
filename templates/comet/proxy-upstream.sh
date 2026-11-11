# The app's load balancing upstream (MUP's upstream.sh, with the content given by comet-deploy).
# mode: write = replace the file with content64 (base64) and link every domain; remove = remove
# the file and the links; links = only fix the links. The result is the file and links
# upstream.sh creates, but the file is replaced atomically (temp file + mv) and only this app's
# links are touched, so an interrupted run never leaves an include of a missing file.
set -e
APPNAME=<%- q(appName) %>
PROXYNAME=<%- q(proxyName) %>
UPSTREAM=/opt/$PROXYNAME/upstream/$APPNAME
cd /opt/$PROXYNAME/config/vhost.d

# This app's links for domains that are no longer configured (or all of them, when removing).
for f in *_upstream; do
  if [ -L "$f" ] && [ "$(readlink "$f")" = "../upstream/$APPNAME" ]; then
    case "${f%_upstream}" in
<% if (mode !== 'remove') { domains.forEach(function (domain) { -%>
      <%- q(domain) %>) ;;
<% }) } -%>
      *) sudo rm -f "$f" ;;
    esac
  fi
done

<% if (mode === 'remove') { -%>
# No reload: nginx's current config still includes the file, so the caller regenerates it.
sudo rm -f $UPSTREAM
<% } else { -%>
<% if (mode === 'write') { -%>
echo <%- q(content64) %> | base64 -d | sudo tee $UPSTREAM.tmp > /dev/null
sudo mv -f $UPSTREAM.tmp $UPSTREAM
<% } else { -%>
# Links only: never link a file that does not exist (nginx would reject the include).
[ -f $UPSTREAM ] || { >&2 echo "$UPSTREAM is missing"; exit 1; }
<% } -%>
<% domains.forEach(function (domain) { -%>
sudo ln -sfn ../upstream/$APPNAME <%- q(domain + '_upstream') %>
<% }) -%>
sudo docker exec $PROXYNAME nginx -s reload
<% } -%>
