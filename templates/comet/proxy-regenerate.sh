# Regenerates the nginx config once, without restarting the proxy containers: the docker-gen run
# of the image's Procfile, without -watch. docker-gen decides which vhost.d, upstream and
# certificate files exist when it generates, so a new or removed file needs this; a changed file
# only needs a reload (proxy-reload.sh). nginx -t first: a config nginx rejects is reported
# instead of being left for the next reload, and nginx keeps serving the previous one.
set -e
sudo docker exec mup-nginx-proxy docker-gen /app/nginx.tmpl /etc/nginx/conf.d/default.conf
<% include proxy-reload.sh %>
