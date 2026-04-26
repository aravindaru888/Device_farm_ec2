#!/bin/bash
# tests/run-per-screen.sh
# Runs Flashlight separately for each screen and generates individual reports.
# Usage: bash tests/run-per-screen.sh

set -e

BUNDLE_ID="io.appium.android.apis"
REPORTS_DIR="data/reports"
ITERATIONS=${ITERATIONS:-3}

mkdir -p "$REPORTS_DIR"

echo ""
echo "📱 Per-screen Flashlight measurement"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Iterations per screen: $ITERATIONS"
echo ""

# ── Screen 1: Home ────────────────────────────────────────────────────────────
echo "▶  Screen 1/3: Home screen"
flashlight test \
  --bundleId "$BUNDLE_ID" \
  --testCommand "node tests/apidemos-home.js" \
  --iterationCount "$ITERATIONS" \
  --duration 8000 \
  --resultsTitle "Home Screen" \
  --resultsFilePath "$REPORTS_DIR/screen_1_home.json"

echo "✅ Home screen done"
echo ""

# ── Screen 2: App Menu ────────────────────────────────────────────────────────
echo "▶  Screen 2/3: App Menu screen"
flashlight test \
  --bundleId "$BUNDLE_ID" \
  --testCommand "node tests/apidemos-app-menu.js" \
  --iterationCount "$ITERATIONS" \
  --duration 8000 \
  --resultsTitle "App Menu Screen" \
  --resultsFilePath "$REPORTS_DIR/screen_2_app_menu.json"

echo "✅ App Menu screen done"
echo ""

# ── Screen 3: Action Bar ──────────────────────────────────────────────────────
echo "▶  Screen 3/3: Action Bar screen"
flashlight test \
  --bundleId "$BUNDLE_ID" \
  --testCommand "node tests/apidemos-action-bar.js" \
  --iterationCount "$ITERATIONS" \
  --duration 8000 \
  --resultsTitle "Action Bar Screen" \
  --resultsFilePath "$REPORTS_DIR/screen_3_action_bar.json"

echo "✅ Action Bar screen done"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ All screens measured!"
echo ""
echo "Open individual reports:"
echo "  flashlight report $REPORTS_DIR/screen_1_home.json"
echo "  flashlight report $REPORTS_DIR/screen_2_app_menu.json"
echo "  flashlight report $REPORTS_DIR/screen_3_action_bar.json"
echo ""
echo "Compare all screens side by side:"
echo "  flashlight report $REPORTS_DIR/screen_1_home.json $REPORTS_DIR/screen_2_app_menu.json $REPORTS_DIR/screen_3_action_bar.json"
echo ""
