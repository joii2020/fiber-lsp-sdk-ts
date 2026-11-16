#!/bin/sh
set -e
. "$(dirname -- "$0")/config.sh"
sh examples/devnet/clean.sh
sh examples/devnet/init.sh
