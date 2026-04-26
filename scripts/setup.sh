#!/usr/bin/env bash
# scripts/setup.sh — Device Farm one-time setup
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
fail() { echo -e "${RED}✗${NC}  $*"; exit 1; }

echo ""
echo "  📱 Device Farm — setup"
echo "  ─────────────────────────"
echo ""

# ── Node.js ──────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install from https://nodejs.org (v18+)"
fi
NODE_VER=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
if [ "$NODE_VER" -lt 18 ]; then
  fail "Node.js 18+ required (found v$(node -v))"
fi
ok "Node.js $(node -v)"

# ── ADB ───────────────────────────────────────────────────────────────────────
if ! command -v adb &>/dev/null; then
  warn "adb not found."
  echo "  Install:"
  echo "    macOS:   brew install android-platform-tools"
  echo "    Ubuntu:  sudo apt install adb"
  echo "    Windows: https://developer.android.com/tools/releases/platform-tools"
  echo ""
  warn "Continuing setup — start the server once adb is installed."
else
  ok "adb $(adb version | head -1 | awk '{print $NF}')"
fi

# ── aapt (optional, for APK parsing) ─────────────────────────────────────────
if command -v aapt &>/dev/null; then
  ok "aapt found (APK package name extraction enabled)"
else
  warn "aapt not found (optional — install Android Build Tools for APK metadata)"
fi

# ── Install npm dependencies ──────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo "Installing npm dependencies…"
cd "$ROOT"
npm install --silent
ok "npm packages installed"

# ── Flashlight (optional) ─────────────────────────────────────────────────────
if command -v flashlight &>/dev/null; then
  ok "Flashlight found — full perf reports enabled"
else
  warn "Flashlight not found. For deep metrics, install with:"
  echo "       npm install -g @perf-tools/flashlight"
fi

# ── Data dirs ─────────────────────────────────────────────────────────────────
mkdir -p "$ROOT/data/uploads" "$ROOT/data/reports" "$ROOT/data/screenshots"
ok "Data directories created"

# ── Make CLI executable ────────────────────────────────────────────────────────
chmod +x "$ROOT/cli/index.js"
if [ -d /usr/local/bin ]; then
  if [ -w /usr/local/bin ]; then
    ln -sf "$ROOT/cli/index.js" /usr/local/bin/farm
    ok "CLI linked: you can now run 'farm' from anywhere"
  else
    warn "Can't write to /usr/local/bin — run: sudo ln -sf $ROOT/cli/index.js /usr/local/bin/farm"
  fi
fi

# ── Enable USB debugging reminder ─────────────────────────────────────────────
echo ""
echo "  ─────────────────────────"
echo "  Device setup checklist:"
echo "    1. Settings → About Phone → tap Build Number 7×"
echo "    2. Settings → Developer Options → enable USB Debugging"
echo "    3. Plug in via USB (or use WiFi pair on Android 11+)"
echo ""
echo "  For WiFi debugging (Android 11+):"
echo "    Settings → Developer Options → Wireless Debugging → Pair device with code"
echo "    Then: farm pair <ip> <port> <code>"
echo "  ─────────────────────────"
echo ""

ok "Setup complete!"
echo ""
echo "  Start the server:   npm start"
echo "  Dashboard:          http://localhost:3000"
echo "  Submit a job:       farm run -p com.myapp -c 'adb:am start com.myapp/.Main'"
echo ""
