#!/bin/sh
set -e
mkdir -p "$(dirname "$DB_PATH")"

if [ -n "$LITESTREAM_BUCKET" ]; then
  # Fresh container: restore the latest replica if one exists, then run the
  # server under litestream so every write streams back to GCS.
  litestream restore -if-replica-exists -config /app/litestream.yml "$DB_PATH"
  exec litestream replicate -config /app/litestream.yml -exec "node dist-server/index.js"
else
  echo "LITESTREAM_BUCKET not set — running without replication (local/dev only)"
  exec node dist-server/index.js
fi
