#!/bin/bash
# Env: ROOT_PASSWORD, DEPLOYER_PASSWORD, AUTHORIZED_KEY, ALLOW_TCP_FORWARDING (yes|no)
set -e

# Both users accept their own password and the same public key, so tests can use either
# authentication method with either user.
echo "root:${ROOT_PASSWORD:?}" | chpasswd
echo "deployer:${DEPLOYER_PASSWORD:?}" | chpasswd
for home in /root /home/deployer; do
  mkdir -p "$home/.ssh"
  echo "${AUTHORIZED_KEY:?}" > "$home/.ssh/authorized_keys"
  chmod 700 "$home/.ssh"
  chmod 600 "$home/.ssh/authorized_keys"
done
chown -R deployer:deployer /home/deployer/.ssh

# AllowTcpForwarding=no simulates a server that blocks the SSH reverse tunnel.
cat > /etc/ssh/sshd_config.d/comet-test.conf <<CONF
PermitRootLogin yes
PasswordAuthentication yes
AllowTcpForwarding ${ALLOW_TCP_FORWARDING:-yes}
CONF

# cgroup v2 nesting (same as moby's hack/dind) so the inner dockerd can start.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || :
fi

# dockerd in the background; sshd replaces this shell as the container's main process
# (-D: no daemonizing, -e: log to stderr, i.e. `docker logs`).
dockerd > /var/log/dockerd.log 2>&1 &
exec /usr/sbin/sshd -D -e
