# With no tags to remove: lists "<tag> <id>" for REPO (parsed by parseVersions). Otherwise
# removes each tag and prints "removed <tag>" when Docker did. The tags matched the version
# pattern before they got here, so printing them unquoted is safe.
REPO=<%- q(repo) %>
<% for (const tag of remove) { %>
sudo docker rmi "$REPO":<%- q(tag) %> >/dev/null && echo "removed <%- tag %>"
<% } %>
<% if (remove.length === 0) { %>
sudo docker images --format '{{.Tag}} {{.ID}}' "$REPO"
<% } %>
