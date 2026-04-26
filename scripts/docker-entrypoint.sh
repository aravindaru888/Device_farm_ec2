#!/bin/bash
# scripts/docker-entrypoint.sh

set -e

echo "🚀 Starting Device Farm..."

# Start ADB server
echo "Starting ADB server..."
adb start-server
echo "✅ ADB server started"

# Start Appium in background
echo "Starting Appium..."
appium --relaxed-security --log /app/data/appium.log &
APPIUM_PID=$!
echo "✅ Appium started (pid $APPIUM_PID)"

# Wait for Appium to be ready
sleep 3

# Start device farm server
echo "Starting Device Farm server..."
exec node server/index.js
