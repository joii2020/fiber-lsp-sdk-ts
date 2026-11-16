#!/bin/sh
set -e
. "$(dirname -- "$0")/config.sh"
offckb node --daemon
offckb fiber start --daemon
