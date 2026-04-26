#!/bin/bash
# scripts/ec2-setup.sh
# Run this on a fresh Ubuntu 22.04 EC2 instance
# Installs all dependencies and starts the device farm
#
# Usage:
#   chmod +x ec2-setup.sh
#   sudo bash ec2-setup.sh

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
info() { echo -e "${YELLOW}→${NC} $*"; }

echo ""
echo "  📱 Device Farm — EC2 Setup"
echo "  ─────────────────────────────"
echo ""

# ── System packages ────────────────────────────────────────────────────────────
info "Installing system packages..."
apt-get update -q
apt-get install -y \
    curl wget unzip git \
    android-tools-adb \
    openjdk-17-jdk \
    nginx \
    docker.io \
    docker-compose-plugin \
    socat \
    usbutils
ok "System packages installed"

# ── Docker ─────────────────────────────────────────────────────────────────────
info "Configuring Docker..."
systemctl enable docker
systemctl start docker
usermod -aG docker ubuntu
ok "Docker configured"

# ── Node.js 20 ─────────────────────────────────────────────────────────────────
info "Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
ok "Node.js $(node -v) installed"

# ── Appium ─────────────────────────────────────────────────────────────────────
info "Installing Appium..."
npm install -g appium
appium driver install uiautomator2
ok "Appium installed"

# ── Flashlight ────────────────────────────────────────────────────────────────
info "Installing Flashlight..."
curl -Ls https://get.flashlight.dev -o /tmp/fl-install.sh
bash /tmp/fl-install.sh
rm /tmp/fl-install.sh
echo 'export PATH="$HOME/.flashlight/bin:$PATH"' >> /etc/environment
source /etc/environment
ok "Flashlight installed"

# ── ADB config ────────────────────────────────────────────────────────────────
info "Configuring ADB for TCP connections..."
# Allow ADB connections over TCP (for WiFi device connections)
adb start-server
# Open ADB port for incoming device connections
cat >> /etc/udev/rules.d/51-android.rules << 'EOF'
SUBSYSTEM=="usb", ATTR{idVendor}=="*", MODE="0666", GROUP="plugdev"
EOF
udevadm control --reload-rules
ok "ADB configured"

# ── Clone and setup device farm ────────────────────────────────────────────────
info "Setting up Device Farm..."
cd /opt
git clone YOUR_REPO_URL device-farm || true
cd device-farm
npm install
mkdir -p data/uploads data/reports data/screenshots
ok "Device Farm installed"

# ── Systemd service — Device Farm ─────────────────────────────────────────────
info "Creating Device Farm service..."
cat > /etc/systemd/system/device-farm.service << 'EOF'
[Unit]
Description=Device Farm Server
After=network.target adb.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/device-farm
ExecStartPre=/usr/bin/adb start-server
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
Environment=PORT=3000
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# ── Systemd service — Appium ───────────────────────────────────────────────────
cat > /etc/systemd/system/appium.service << 'EOF'
[Unit]
Description=Appium Server
After=network.target

[Service]
Type=simple
User=ubuntu
ExecStart=/usr/bin/appium --relaxed-security --log /opt/device-farm/data/appium.log
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
systemctl start device-farm
ok "Services started"

# ── Firewall ───────────────────────────────────────────────────────────────────
info "Configuring firewall..."
ufw --force enable
ufw allow ssh
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw allow 3000/tcp  # Device Farm API (restrict this to your IP in production)
ufw allow 5555/tcp  # ADB WiFi device connections
ufw allow 4723/tcp  # Appium (restrict to internal only in production)
ok "Firewall configured"

# ── Nginx ─────────────────────────────────────────────────────────────────────
info "Configuring Nginx..."
cat > /etc/nginx/sites-available/device-farm << 'EOF'
# HTTP → redirect to HTTPS
server {
    listen 80;
    server_name _;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name _;

    ssl_certificate     /etc/nginx/certs/cert.pem;
    ssl_certificate_key /etc/nginx/certs/key.pem;

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
mkdir -p /etc/nginx/certs
ok "Nginx configured (add SSL certs to /etc/nginx/certs/)"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "  ─────────────────────────────────────"
echo "  ✅ EC2 setup complete!"
echo ""
echo "  Next steps:"
echo "  1. Add SSL cert: /etc/nginx/certs/cert.pem + key.pem"
echo "     (use: certbot --nginx  OR  copy from ACM)"
echo "  2. Connect your phone:"
echo "     adb connect <EC2_PUBLIC_IP>:5555"
echo "  3. Point your laptop CLI:"
echo "     export FARM_URL=https://<EC2_PUBLIC_IP>"
echo "  4. Check status:"
echo "     systemctl status device-farm"
echo "     systemctl status appium"
echo "  ─────────────────────────────────────"
echo ""
