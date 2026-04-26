#!/bin/bash
# scripts/ec2-setup.sh
# Compatible with Ubuntu 22.04 and 24.04 (Noble)
# Run from the device-farm directory:
#   sudo bash scripts/ec2-setup.sh

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
info() { echo -e "${YELLOW}→${NC} $*"; }

# Detect the actual user who invoked sudo
REAL_USER=${SUDO_USER:-ubuntu}
FARM_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

echo ""
echo "  📱 Device Farm — EC2 Setup"
echo "  ─────────────────────────────"
echo "  Farm directory : $FARM_DIR"
echo "  Running as     : $REAL_USER"
echo ""

# ── System packages ────────────────────────────────────────────────────────────
info "Installing system packages..."
apt-get update -q
apt-get install -y \
    curl wget unzip git \
    adb \
    openjdk-17-jdk \
    nginx \
    docker.io \
    socat \
    usbutils

# docker-compose — name changed in Ubuntu 24.04
if apt-cache show docker-compose-plugin &>/dev/null; then
    apt-get install -y docker-compose-plugin
else
    apt-get install -y docker-compose || true
fi
ok "System packages installed"

# ── Docker ─────────────────────────────────────────────────────────────────────
info "Configuring Docker..."
systemctl enable docker
systemctl start docker
usermod -aG docker "$REAL_USER"
ok "Docker configured"

# ── Node.js 20 ─────────────────────────────────────────────────────────────────
info "Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
ok "Node.js $(node -v) installed"

# ── npm packages ───────────────────────────────────────────────────────────────
info "Installing npm dependencies..."
cd "$FARM_DIR"
npm install
mkdir -p data/uploads data/reports data/screenshots
chown -R "$REAL_USER":"$REAL_USER" "$FARM_DIR"
ok "npm packages installed"

# ── Appium ─────────────────────────────────────────────────────────────────────
info "Installing Appium..."
npm install -g appium
APPIUM_BIN=$(which appium)
sudo -u "$REAL_USER" appium driver install uiautomator2 || true
ok "Appium installed"

# ── Flashlight ────────────────────────────────────────────────────────────────
info "Installing Flashlight..."
sudo -u "$REAL_USER" bash -c 'curl -Ls https://get.flashlight.dev | bash' || true
FLASHLIGHT_PATH="/home/$REAL_USER/.flashlight/bin"
echo "export PATH=\"$FLASHLIGHT_PATH:\$PATH\"" >> "/home/$REAL_USER/.bashrc"
ok "Flashlight installed"

# ── ADB ───────────────────────────────────────────────────────────────────────
info "Configuring ADB..."
adb start-server || true
cat > /etc/udev/rules.d/51-android.rules << 'EOF'
SUBSYSTEM=="usb", ATTR{idVendor}=="*", MODE="0666", GROUP="plugdev"
EOF
udevadm control --reload-rules 2>/dev/null || true
ok "ADB configured"

# ── Swap (important for t2.micro 1GB RAM) ─────────────────────────────────────
if ! swapon --show | grep -q swap; then
    info "Adding 2GB swap (needed for t2.micro)..."
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "Swap enabled"
fi

# ── Systemd — Device Farm ─────────────────────────────────────────────────────
info "Creating systemd services..."
NODE_BIN=$(which node)

cat > /etc/systemd/system/device-farm.service << EOF
[Unit]
Description=Device Farm Server
After=network.target

[Service]
Type=simple
User=$REAL_USER
WorkingDirectory=$FARM_DIR
ExecStartPre=/usr/bin/adb start-server
ExecStart=$NODE_BIN server/index.js
Restart=always
RestartSec=5
Environment=PORT=3000
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# ── Systemd — Appium ──────────────────────────────────────────────────────────
cat > /etc/systemd/system/appium.service << EOF
[Unit]
Description=Appium Server
After=network.target

[Service]
Type=simple
User=$REAL_USER
ExecStart=$APPIUM_BIN --relaxed-security --log $FARM_DIR/data/appium.log
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable device-farm appium
systemctl start appium
sleep 3
systemctl start device-farm
ok "Services started"

# ── Firewall ───────────────────────────────────────────────────────────────────
info "Configuring firewall..."
ufw --force enable
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp
ufw allow 5555/tcp
ufw allow 4723/tcp
ok "Firewall configured"

# ── Nginx ─────────────────────────────────────────────────────────────────────
info "Configuring Nginx..."
mkdir -p /etc/nginx/certs

cat > /etc/nginx/sites-available/device-farm << 'EOF'
server {
    listen 80;
    server_name _;

    client_max_body_size 500M;

    location /api/ {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
    }
}
EOF

ln -sf /etc/nginx/sites-available/device-farm /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
ok "Nginx configured"

# ── Verify ────────────────────────────────────────────────────────────────────
sleep 2
if curl -sf http://localhost:3000/api/stats &>/dev/null; then
    ok "Device farm is responding"
else
    echo "⚠  Farm not responding yet — check: sudo journalctl -u device-farm -n 50"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
EC2_IP=$(curl -sf http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "<EC2-PUBLIC-IP>")

echo ""
echo "  ─────────────────────────────────────"
echo "  ✅ Setup complete!"
echo ""
echo "  Dashboard  : http://$EC2_IP:3000"
echo "  API stats  : http://$EC2_IP:3000/api/stats"
echo ""
echo "  Connect your phone:"
echo "    1. Phone: Settings → Developer Options → Wireless Debugging → ON"
echo "    2. Laptop: node cli/index.js pair <PHONE-IP> <PAIR-PORT> <CODE>"
echo "    3. Laptop: node cli/index.js connect <PHONE-IP> <CONNECT-PORT>"
echo ""
echo "  Check service logs:"
echo "    sudo journalctl -u device-farm -f"
echo "    sudo journalctl -u appium -f"
echo "  ─────────────────────────────────────"
echo ""
