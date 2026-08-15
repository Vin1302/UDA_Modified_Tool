#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# DataBridge AI — Azure VM Deployment Script
# Run this on a fresh Ubuntu 22.04 Azure VM as root or with sudo
# Usage: bash deploy.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e
echo "════════════════════════════════════════════"
echo "  DataBridge AI — Azure VM Setup"
echo "════════════════════════════════════════════"

# ── 1. System packages ────────────────────────────────────────────────────────
echo "→ Updating system packages..."
apt-get update -y && apt-get upgrade -y
apt-get install -y curl git nginx ufw

# ── 2. Node.js 20 LTS ────────────────────────────────────────────────────────
echo "→ Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version && npm --version

# ── 3. PM2 (process manager) ─────────────────────────────────────────────────
echo "→ Installing PM2..."
npm install -g pm2

# ── 4. Copy project to /var/www ───────────────────────────────────────────────
echo "→ Setting up project directory..."
mkdir -p /var/www/databridge
cp -r . /var/www/databridge/
cd /var/www/databridge

# ── 5. Backend setup ──────────────────────────────────────────────────────────
echo "→ Installing backend dependencies..."
cd /var/www/databridge/backend
npm install --production
mkdir -p output uploads

# ── 6. .env file ─────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "⚠️  IMPORTANT: Edit /var/www/databridge/backend/.env with your Azure OpenAI keys!"
  echo "   Run: nano /var/www/databridge/backend/.env"
  echo ""
fi

# ── 7. Frontend build ─────────────────────────────────────────────────────────
echo "→ Building React frontend..."
cd /var/www/databridge/frontend
npm install
REACT_APP_API_URL="" npm run build   # empty = same-origin (nginx proxies /api)

# ── 8. PM2 — start backend ───────────────────────────────────────────────────
echo "→ Starting backend with PM2..."
cd /var/www/databridge/backend
NODE_ENV=production pm2 start server.js --name databridge-api
pm2 save
pm2 startup systemd -u $USER --hp $HOME | tail -1 | bash   # auto-start on reboot

# ── 9. Nginx config ───────────────────────────────────────────────────────────
echo "→ Configuring Nginx..."
cp /var/www/databridge/nginx/databridge.conf /etc/nginx/sites-available/databridge
ln -sf /etc/nginx/sites-available/databridge /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ── 10. Firewall ──────────────────────────────────────────────────────────────
echo "→ Configuring firewall..."
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo ""
echo "════════════════════════════════════════════"
echo "  ✅ Deployment complete!"
echo "  1. Edit /var/www/databridge/backend/.env"
echo "  2. Run: pm2 restart databridge-api"
echo "  3. Open: http://$(curl -s ifconfig.me)"
echo "════════════════════════════════════════════"
