set -e
# Base image layers come from its own registry (fast on the server side);
# only the app layers travel through the SSH tunnel.
sudo docker pull <%- baseImage %> || true
sudo docker pull 127.0.0.1:<%- remotePort %>/<%- registryRef %>
sudo docker tag 127.0.0.1:<%- remotePort %>/<%- registryRef %> <%- targetTag %>
sudo docker rmi 127.0.0.1:<%- remotePort %>/<%- registryRef %>
