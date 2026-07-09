#!/usr/bin/env bash
set -euo pipefail

echo "=== Updating system ==="
sudo apt update -y && sudo apt upgrade -y

echo "=== Installing Node.js 22 LTS ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs
node -v && npm -v

echo "=== Installing FFmpeg ==="
sudo apt install -y ffmpeg

echo "=== Installing yt-dlp ==="
ARCH=$(uname -m)
if [ "$ARCH" = "aarch64" ]; then
  YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64"
else
  YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
fi
sudo curl -fsSL -o /usr/local/bin/yt-dlp "$YTDLP_URL"
sudo chmod +x /usr/local/bin/yt-dlp
yt-dlp --version

echo "=== Installing PM2 ==="
sudo npm i -g pm2

echo "=== Installing bot dependencies ==="
npm install

echo "=== Creating log directory ==="
mkdir -p logs

echo "=== Setting up .env ==="
if [ ! -f .env ]; then
  cat > .env << 'ENVEOF'
DISCORD_TOKEN=your_token_here
CLIENT_ID=your_client_id_here
GENIUS_API_KEY=
SOUNDCLOUD_CLIENT_ID=
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
ENVEOF
  echo "Created .env — EDIT IT: nano .env"
fi

echo ""
echo "=== DEPLOYMENT READY ==="
echo "1. Edit .env: nano .env"
echo "2. Start bot: pm2 start ecosystem.config.cjs"
echo "3. Save PM2: pm2 save && sudo env PATH=\$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu"
echo ""
