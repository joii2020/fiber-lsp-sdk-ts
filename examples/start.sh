#!/bin/sh
set -e
cd "$(dirname -- "$0")/.."
mkdir -p .devnet
command -v lsof > /dev/null
pids=$(lsof -tiTCP:8008 -sTCP:LISTEN || true)
if [ -n "$pids" ]; then
  kill $pids
fi
nohup pnpm example >> .devnet/example.log 2>&1 < /dev/null &
