#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="$SCRIPT_DIR${PYTHONPATH:+:$PYTHONPATH}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] python3 is required to run patch-linux.sh" >&2
  exit 1
fi

exec python3 -m patcher_core.cli "$@"
