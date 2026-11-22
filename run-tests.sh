#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "[1/3] Running Python core, Linux & sanitization tests..."
python3 tests/run_all_tests.py

echo "[2/3] Running JS module & runtime smoke tests..."
node tests/test_modules_behavior.js

if command -v cargo >/dev/null 2>&1; then
  echo "[3/3] Running Rust unit tests..."
  (cd patcher/src-tauri && cargo test --lib)
else
  echo "[3/3] Skipping Rust tests (cargo not installed)."
fi

echo "[OK] All tests passed!"
