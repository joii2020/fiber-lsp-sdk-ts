#!/bin/sh
set -e
. "$(dirname -- "$0")/config.sh"
sh examples/devnet/stop.sh
offckb node --daemon
offckb fiber init --nodes 3 --binary-path "$FNN_PATH"
node examples/devnet/configure.ts
mkdir -p .devnet/keys
printf '%s\n' 'read("node"); read("lsp"); write("lsp");' |
  biscuit generate --private-key-file "$FIBER_NODE_DIR/biscuit/private.key" - > .devnet/keys/operator-token
offckb fiber start --daemon
