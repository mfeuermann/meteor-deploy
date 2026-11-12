# Server facts for the preflight checks; prints key=value lines for parseFacts.
# POSIX sh only: it runs with `sh -s`, before we know that bash exists.
echo "arch=$(uname -m)"
# Every remote script runs its commands through sudo (MUP does the same), so
# sudo must exist and must not ask for a password (-n fails instead of asking).
if command -v sudo >/dev/null 2>&1; then
  if sudo -n true >/dev/null 2>&1; then echo "sudo=ok"; else echo "sudo=password"; fi
else
  echo "sudo=missing"
fi
ver=""
running=0
free=""
# The daemon is asked through sudo like everywhere else. When that fails (daemon down, or sudo
# wants a password), only the client version is known and docker_running stays 0.
if command -v docker >/dev/null 2>&1; then
  if sudo docker info >/dev/null 2>&1; then
    running=1
    ver=$(sudo docker version --format '{{.Server.Version}}' 2>/dev/null)
    # Free bytes on the filesystem of Docker's data root, where pulled layers are stored.
    root=$(sudo docker info --format '{{.DockerRootDir}}' 2>/dev/null)
    free=$(df -Pk "${root:-/var/lib/docker}" 2>/dev/null | awk 'NR==2 {printf "%.0f", $4 * 1024}')
  fi
  if [ -z "$ver" ]; then
    ver=$(docker --version 2>/dev/null | sed -E 's/^Docker version ([^,]+).*/\1/')
  fi
fi
echo "docker=$ver"
echo "docker_running=$running"
echo "docker_free=$free"
if command -v bash >/dev/null 2>&1; then echo "bash=1"; else echo "bash=0"; fi
<% if (configDir) { %>
# Only asked for by commands that need the app directories that `setup` creates.
if [ -d <%- q(configDir) %> ]; then echo "app_setup=1"; else echo "app_setup=0"; fi
<% } %>
<% if (proxyName) { %>
# Only asked for on the servers the reverse proxy runs on.
if [ "$(sudo docker inspect -f '{{.State.Running}}' <%- q(proxyName) %> 2>/dev/null)" = "true" ]; then echo "proxy_running=1"; else echo "proxy_running=0"; fi
<% } %>
<% if (mongoName) { %>
# Only asked for when the config has a "mongo" section: the app is linked to this container.
if [ "$(sudo docker inspect -f '{{.State.Running}}' <%- q(mongoName) %> 2>/dev/null)" = "true" ]; then echo "mongo_running=1"; else echo "mongo_running=0"; fi
# The file "mongo start" needs, written by "mongo setup".
if sudo test -f /opt/mongodb/mongo-start-new.sh; then echo "mongo_set_up=1"; else echo "mongo_set_up=0"; fi
<% } %>
