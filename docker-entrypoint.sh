#!/bin/sh
# Hosting platforms often mount volumes owned by root. Fix ownership once, then drop to the
# unprivileged "node" user so hosted code never runs as root.
set -e
mkdir -p "$DATA_DIR"
if [ "$(id -u)" = "0" ]; then
  if [ "$(stat -c %U "$DATA_DIR")" != "node" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  exec setpriv --reuid=node --regid=node --init-groups node server.js
fi
exec node server.js
