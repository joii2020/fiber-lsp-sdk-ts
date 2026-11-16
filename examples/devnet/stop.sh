#!/bin/sh
set -e
. "$(dirname -- "$0")/config.sh"
offckb fiber stop
offckb node stop
