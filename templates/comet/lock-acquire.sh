# Atomic lock: mkdir succeeds for exactly one deployer. info.json was uploaded
# beforehand (SFTP) to a temp file and is moved into the lock directory.
# The first line printed is the status: acquired, held (then the holder's info.json follows)
# or missing-config (setup was not run).
CONFIG_DIR=<%- q(configDir) %>
LOCK_DIR=<%- q(lockDir) %>
TMP_INFO=<%- q(tmpInfo) %>
if [ ! -d "$CONFIG_DIR" ]; then
  echo "missing-config"
  exit 0
fi
if mkdir <%- q(lockDir) %> 2>/dev/null; then
  # A lock without info.json could not be told apart from a stale one: give it back instead.
  if ! mv "$TMP_INFO" "$LOCK_DIR/info.json"; then
    rmdir "$LOCK_DIR"
    >&2 echo "Cannot write $LOCK_DIR/info.json"
    exit 1
  fi
  echo "acquired"
else
  rm -f "$TMP_INFO"
  echo "held"
  cat "$LOCK_DIR/info.json" 2>/dev/null || true
fi
