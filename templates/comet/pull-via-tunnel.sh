set -e
# Base image layers come from its own registry (fast on the server side);
# only the app layers travel through the SSH tunnel.
sudo docker pull <%- q(baseImage) %> || true
sudo docker pull <%- q(tunnelRef) %>
sudo docker tag <%- q(tunnelRef) %> <%- q(targetTag) %>
sudo docker rmi <%- q(tunnelRef) %>
