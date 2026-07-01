#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-5174}"

if [ ! -d node_modules ]; then
  npm install
fi

npm run build

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null; then
  echo "Port $PORT is already in use."
  echo "Open http://$HOST:$PORT/ to label images."
  exit 0
fi

echo "Starting labeling app at http://$HOST:$PORT/"
npm run preview -- --host "$HOST" --port "$PORT"
