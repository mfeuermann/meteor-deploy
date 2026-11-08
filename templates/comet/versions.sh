REPO=<%- q(repo) %>
<% for (const tag of remove) { %>
sudo docker rmi "$REPO":<%- q(tag) %> >/dev/null && echo "removed <%- tag %>"
<% } %>
<% if (remove.length === 0) { %>
sudo docker images --format '{{.Tag}} {{.ID}}' "$REPO"
<% } %>
