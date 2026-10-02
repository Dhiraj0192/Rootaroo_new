#!/usr/bin/env bash
# Restart Rootaroo API so new routes (e.g. /auth/phone/register) load.
set -euo pipefail
cd "$(dirname "$0")"

echo "Stopping old API on :3000 (if any)..."
fuser -k 3000/tcp 2>/dev/null || true
pkill -f 'rootaroo/server.*tsx src/index.ts' 2>/dev/null || true
sleep 1

export DB_SOCKET="${DB_SOCKET:-/opt/lampp/var/mysql/mysql.sock}"
if [[ -S "$DB_SOCKET" ]]; then
  echo "Using MySQL socket: $DB_SOCKET"
else
  echo "MySQL socket not found at $DB_SOCKET — using TCP from .env"
  unset DB_SOCKET
fi

echo "Starting API..."
exec npx tsx src/index.ts
