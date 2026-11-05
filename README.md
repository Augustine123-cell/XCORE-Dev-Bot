# 𝚇𝙲𝙾𝚁𝙴® — WhatsApp Developer Bot (Node.js)

By **𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽** · SHΔDOWBORNE LΔB. This is the Node.js / Baileys port of the Python "AntiBug v2" project. Same commands,
same `db.json` format, same anti-bug engine, same Telegram dashboard.

## Run it (one step at a time)

```bash
npm install                 # 1. install dependencies (needs internet)
cp .env.example .env        # 2. then fill in TELEGRAM_BOT_TOKEN and BAN_CHECKER_API_KEY
                            #    (or copy your existing .env across — the variable names are unchanged)
npm run preflight           # 3. optional: checks config + dependencies
npm start                   # 4. start the bot
```

Requires **Node 20.12+** (22 recommended). Termux: run `bash termux-install.sh`.

## Layout

```
src/index.js              entry point            src/telegramBot.js    Telegram dashboard (Stars, pairing, owner panel)
src/app.js                startup / shutdown     src/telegram/api.js   tiny Bot API client (fetch, no dependencies)
src/config.js  paths.js   env + storage paths    src/whatsapp/socket.js   ONLY file that touches Baileys
src/db.js  clans.js       JSON database          src/whatsapp/security.js anti-bug engine
src/format.js             cards + menu           src/whatsapp/handler.js  inbound pipeline
src/monitor.js server.js  uptime monitor, /      src/whatsapp/commands/   all ® / @ commands
tests/                    141 tests (npm test)
```

## Features

WhatsApp: ban check, device/client lookups, clan scan, group admin (®ordain ®strip ®ban ®expel ®purge ®sweepclean ®jid),
dev tools (®gitclone ®mediafire ®apify ®apilab ®watch ®monitor), ®save contact, ®readqr, OSINT (premium), modes
(public/self/dev/maintenance/stealth), roles (OWNER/SUDO/PREMIUM/PAIRED/USER), **Anti-Bug** (0–100 scoring, auto-block,
purge, shield, owner alerts with effectiveness %).
Telegram: force-join gate, `/pair` WhatsApp pairing, Stars `/buy`, owner panel (`/admin`, `/pairnumber`, `/unpair`, `/paired`,
`/ram`, `/mode`, `/antiban`, `/grantpremium`, `/revokepremium`, `/sudoadd`, `/sudoremove`).

Prefixes are `®` and `@` (`COMMAND_PREFIXES`). Try `®menu`.

## Configuration

See `.env.example`. Required: `TELEGRAM_BOT_TOKEN`, `BAN_CHECKER_API_KEY`. On Railway set them in the **Variables** panel
(a bundled `.env` is not read there) and attach a **Volume** — `RAILWAY_VOLUME_MOUNT_PATH` is detected automatically and
`data/` + `sessions/` live inside it. See `DEPLOYMENT_CHECKLIST.md`.

## Differences from the Python version (read this)

| Area | Python | Node |
|---|---|---|
| WhatsApp library | neonize (whatsmeow) | **Baileys** — sessions are folders in `sessions/<number>/` (**old Python sessions cannot be reused; pair again once**) |
| Pairing code | `XXXXXXXX` | shown as `XXXX-XXXX` (WhatsApp accepts it either way) |
| QR fallback in console | yes | removed — pairing codes only |
| ®readqr | zxing-cpp | `jimp` + `jsqr` (decodes one QR per image) |
| Telegram | python-telegram-bot, updates processed one at a time | own fetch client; updates run **concurrently**, so a long pairing wait no longer blocks the whole dashboard |
| Logged-out session | logged only | credentials folder is deleted automatically (they are dead anyway) — pair again |
| `®device` / `®clientid` | neonize device query | Baileys `getUSyncDevices` when present, otherwise a clear "not exposed" message |

`db.json`, `clans.json`, all command names, all reply texts and the anti-bug scoring are unchanged.
The version range for Baileys in `package.json` is `^6.7.0`; if WhatsApp changes its protocol and pairing stops working,
update it (`npm install @whiskeysockets/baileys@latest`). Everything that touches Baileys is in `src/whatsapp/socket.js`.

## Tests

`npm test` runs 141 tests: anti-bug scoring/counter/shield, commands, db, config, SSRF guard, persistence, Telegram
(including a real HTTP polling loop against a local mock Bot API), and the Baileys adapter against a fake Baileys module.

## XCORE AI

XCORE AI is the conversational AI layer built into the WhatsApp engine. It supports OpenAI and Gemini through provider adapters, with per-chat AI mode, bounded conversation memory, a local XCORE knowledge base, protected-information rules, response caching, and optional web search grounding.

### Configuration

```env
AI_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
AI_USE_WEB_SEARCH=true
AI_TIMEOUT_MS=12000
```

### WhatsApp controls

```text
@ai on
@ai off
@ai status
@ai provider
@ai provider openai
@ai provider gemini
@ai teach <approved public knowledge>
@ai reset
```

`@ai provider ...` and `@ai teach ...` are owner-only. Automatic responses are enabled per chat and are limited to relevant questions, direct messages, XCORE mentions, or replies to the bot. Secrets and private configuration are not placed in the AI knowledge context.
