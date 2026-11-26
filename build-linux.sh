#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/patcher"

for cmd in cargo npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[ERROR] '$cmd' is not installed. Please install Rust (rustup.rs) and Node.js 20+." >&2
    exit 1
  fi
done

if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  echo "[WARN] libwebkit2gtk-4.1 dev headers not detected via pkg-config." >&2
  echo "  Ubuntu/Debian: sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev" >&2
  echo "  Fedora:        sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel" >&2
  echo "  Arch Linux:    sudo pacman -S webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg" >&2
fi

if [ ! -d "node_modules" ]; then
  npm ci --no-fund --no-audit
fi

if ! cargo tauri --version >/dev/null 2>&1; then
  echo "[INFO] Installing tauri-cli..."
  cargo install tauri-cli --locked
fi

cargo tauri build --no-bundle

BIN_SRC="$SCRIPT_DIR/patcher/src-tauri/target/release/ave-maria-patcher"
BIN_DST="$SCRIPT_DIR/AntigravityPatcher"
if [ ! -f "$BIN_SRC" ]; then
  echo "[ERROR] Built binary not found: $BIN_SRC" >&2
  exit 1
fi
cp -f -- "$BIN_SRC" "$BIN_DST"
chmod +x "$BIN_DST"

echo "[OK] Built $BIN_DST"
