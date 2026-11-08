# Atomic lock: mkdir succeeds for exactly one deployer. info.json was uploaded
# beforehand (SFTP) to a temp file and is moved into the lock directory.
CONFIG_DIR=<%- q(configDir) %>
LOCK_DIR=<%- q(lockDir) %>
TMP_INFO=<%- q(tmpInfo) %>
if [ ! -d "$CONFIG_DIR" ]; then
  echo "missing-config"
  exit 0
fi
if mkdir <%- q(lockDir) %> 2>/dev/null; then
  mv "$TMP_INFO" "$LOCK_DIR/info.json"
  echo "acquired"
else
  rm -f "$TMP_INFO"
  echo "held"
  cat "$LOCK_DIR/info.json" 2>/dev/null || true
fi
