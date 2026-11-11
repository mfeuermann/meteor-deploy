# The last lines of the deploy history (limit is a number); nothing when there is no file yet.
tail -n <%- limit %> <%- q(file) %> 2>/dev/null || true
