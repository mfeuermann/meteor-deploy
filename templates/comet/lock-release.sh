<% if (readOnly) { %>
LOCK_DIR=<%- q(lockDir) %>
if [ -d "$LOCK_DIR" ]; then
  echo "held"
  cat "$LOCK_DIR/info.json" 2>/dev/null || true
else
  echo "none"
fi
<% } else { %>
rm -rf <%- q(lockDir) %>
<% } %>
