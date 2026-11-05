# Deployment checklist (Node.js)

## Before you deploy
- [ ] `npm install` finished without errors, then `npm run preflight` shows no `[FAIL]`.
- [ ] `TELEGRAM_BOT_TOKEN` and `BAN_CHECKER_API_KEY` set.
- [ ] `OWNER_NUMBER` (and optional `OWNER_NUMBERS`) are digits only with country code.
- [ ] `TELEGRAM_ADMIN_ID` / `OWNER_TELEGRAM_IDS` are your numeric Telegram IDs.
- [ ] Never commit `.env`; rotate any key that was ever shared in a zip or chat.

## Railway
1. New service from this repo (Nixpacks detects Node; `railway.json` sets the start command).
2. **Variables** panel: add the variables from `.env.example` (do not rely on a bundled `.env`).
3. **Volume**: attach one, mount path e.g. `/data`. `RAILWAY_VOLUME_MOUNT_PATH` is detected; data → `/data/data`, sessions → `/data/sessions`.
4. Deploy. Logs should say `Persistent storage OK`, `Health server`, `Telegram bot online`, then `Session open` (or a pairing code).
5. Redeploy once and confirm you are **not** asked to pair again.

## Docker / VPS
`docker compose up -d --build` (mounts `./sessions`, `./data`, `./logs`) or `pm2 start ecosystem.config.cjs`.

## Termux
`bash termux-install.sh`, edit `.env`, `node src/index.js`.

## After first start
- [ ] `®ping` and `®menu` answer on WhatsApp.
- [ ] `/start` works on Telegram; `/pair` returns a code for a test number.
- [ ] `®antibug status` shows protection ON.
- [ ] If pairing keeps failing: update Baileys (`npm install @whiskeysockets/baileys@latest`) and retry.
