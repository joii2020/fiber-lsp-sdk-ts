#!/bin/sh
cd "$(dirname -- "$0")/../.."
FNN_PATH="$PWD/../fiber/target/release/fnn"
export FIBER_NODE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/offckb-nodejs/devnet/fiber/nodes/3"
