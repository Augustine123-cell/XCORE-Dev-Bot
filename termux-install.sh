#!/data/data/com.termux/files/usr/bin/bash
set -e
pkg update -y
pkg install nodejs-lts git nano -y
npm install --omit=dev
cp -n .env.example .env 2>/dev/null || true
echo "Fill TELEGRAM_BOT_TOKEN and BAN_CHECKER_API_KEY in .env"
echo "Then run: node src/index.js"
