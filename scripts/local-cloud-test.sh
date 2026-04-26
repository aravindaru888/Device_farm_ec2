#!/bin/bash
# scripts/local-cloud-test.sh
# Test the cloud setup locally using Docker before deploying to EC2
# This mirrors exactly what runs on EC2/EKS
#
# Usage: bash scripts/local-cloud-test.sh

set -e

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
info() { echo -e "${YELLOW}→${NC} $*"; }

echo ""
echo "  📱 Device Farm — Local Cloud Test"
echo "  ──────────────────────────────────"
echo ""

# Check Docker is running
if ! docker info &>/dev/null; then
  echo "Docker not running. Start Docker Desktop first."
  exit 1
fi
ok "Docker is running"

# Generate self-signed cert for local HTTPS
if [ ! -f nginx/certs/cert.pem ]; then
  info "Generating self-signed SSL certificate..."
  mkdir -p nginx/certs
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout nginx/certs/key.pem \
    -out nginx/certs/cert.pem \
    -subj "/CN=localhost" 2>/dev/null
  ok "SSL certificate generated"
fi

# Build and start
info "Building Docker image..."
docker-compose build --quite
ok "Image built"

info "Starting services..."
docker-compose up -d
ok "Services started"

# Wait for health check
info "Waiting for server to be ready..."
for i in {1..20}; do
  if curl -sf http://localhost:3000/api/stats &>/dev/null; then
    break
  fi
  sleep 2
done
ok "Server is ready"

echo ""
echo "  ──────────────────────────────────"
echo "  ✅ Local cloud setup running!"
echo ""
echo "  Dashboard : http://localhost:3000"
echo "  API       : http://localhost:3000/api/stats"
echo ""
echo "  Connect your phone:"
echo "    On phone: Settings → Developer Options → Wireless Debugging → ON"
echo "    Get port from Wireless Debugging screen"
echo "    adb connect <PHONE_IP>:<PORT>"
echo ""
echo "  Run a test:"
echo "    export FARM_URL=http://localhost:3000"
echo "    node cli/index.js devices"
echo "    node cli/index.js run -p com.myapp"
echo ""
echo "  Stop:"
echo "    docker compose down"
echo "  ──────────────────────────────────"
echo ""
