# POSIX sh (runs before we know bash exists). Prints key=value lines.
echo "arch=$(uname -m)"
ver=""
running=0
free=""
if command -v docker >/dev/null 2>&1; then
  if sudo docker info >/dev/null 2>&1; then
    running=1
    ver=$(sudo docker version --format '{{.Server.Version}}' 2>/dev/null)
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
