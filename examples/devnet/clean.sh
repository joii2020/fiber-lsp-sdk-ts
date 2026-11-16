#!/bin/sh
set -e
. "$(dirname -- "$0")/config.sh"
sh examples/devnet/stop.sh
offckb clean
rm -rf .devnet
