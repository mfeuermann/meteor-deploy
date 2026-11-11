set -e
# Base image layers come from its own registry (fast on the server side);
# only the app layers travel through the SSH tunnel. A failed base pull is fine (no internet
# access, private base image): the tunnel pull then brings those layers as well.
sudo docker pull <%- q(baseImage) %> || true
# The tunnel ends on the server's loopback. Docker allows plain HTTP to registries on
# 127.0.0.0/8, so no TLS or insecure-registries setting is needed.
sudo docker pull <%- q(tunnelRef) %>
# Keep only the version tag: the tunnel reference names a port that is gone after this deploy.
sudo docker tag <%- q(tunnelRef) %> <%- q(targetTag) %>
sudo docker rmi <%- q(tunnelRef) %>
