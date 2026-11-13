# Fake deploy target for integration tests: Debian (MUP's scripts assume apt-get)
# with Docker preinstalled (so `setup` tests do not download it every time),
# sshd, sudo and a passwordless-sudo `deployer` user in the docker group. openssl is there
# because `proxy status` reads certificate dates with it, as on a typical server. socat is only
# for the tests: it forwards 127.0.0.1:<port> to the test registry (test/harness/registry.ts).
FROM debian:bookworm

# The Docker release installed in the fake server; fake-servers.ts builds one image per version.
ARG DOCKER_VERSION=27.5

# Docker is pinned (DOCKER_VERSION) so that a new get.docker.com release does not change test results.
# /run/sshd is the privilege separation directory sshd needs to start.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
     openssh-server sudo curl ca-certificates bash iproute2 iptables procps openssl socat \
  && curl -fsSL https://get.docker.com -o /tmp/get-docker.sh \
  && sh /tmp/get-docker.sh --version "$DOCKER_VERSION" \
  && rm -rf /var/lib/apt/lists/* /tmp/get-docker.sh \
  && mkdir -p /run/sshd \
  && useradd -m -s /bin/bash -G docker deployer \
  && echo 'deployer ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deployer \
  && chmod 0440 /etc/sudoers.d/deployer

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Inner Docker data must not live on the container's overlayfs (nested overlay).
VOLUME /var/lib/docker
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
