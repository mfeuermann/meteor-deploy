# POSIX sh (runs before we know bash exists). Prints key=value lines.
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
