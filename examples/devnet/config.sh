#!/bin/sh
cd "$(dirname -- "$0")/../.."
export FIBER_NODE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/offckb-nodejs/devnet/fiber/nodes/3"
