/** Application entrypoint: health server + Telegram admin bot + WhatsApp session + monitor. */
import * as config from "./config.js";
import * as db from "./db.js";
import * as logger from "./logger.js";
import * as monitor from "./monitor.js";
import * as paths from "./paths.js";
import * as runtime from "./runtime.js";
import * as server from "./server.js";
import * as wa from "./whatsapp/socket.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run() {
  let cfg;
  try {
    cfg = config.get();
  } catch (e) {
    logger.error(`Fatal config error: ${e.message}`);
    logger.error(
      "Set every required variable (TELEGRAM_BOT_TOKEN, BAN_CHECKER_API_KEY) in your host's " +
        "Environment Variables panel — a bundled .env file is NOT read on Railway/most hosts.",
    );
    process.exit(1);
  }

  try {
    await wa.baileysLoader.load();
  } catch (e) {
    logger.error(`Missing dependency: ${e.message}. Run: npm install`);
    process.exit(1);
  }

  process.on("unhandledRejection", (reason) => logger.error("unhandled:", reason));
  process.on("uncaughtException", (err) => logger.error("uncaught:", err));

  let stopResolve;
  const stopped = new Promise((r) => { stopResolve = r; });

  logger.ok(`${cfg.bot.name} v1.0 starting…`);
  const st = paths.bootstrap(cfg.paths.data, cfg.paths.sessions);
  logger.info(`Data dir: ${st.data}  •  Sessions dir: ${st.sessions}`);
  if (st.seeded.length) logger.info(`Seeded defaults: ${st.seeded.join(", ")}`);
  for (const w of st.warnings) logger.warn(w);
  if (st.persistent) logger.ok("Persistent storage OK — data survives redeploys");
  db.load();
  await server.start(() => wa.listSessions().length);

  // Telegram admin bot — optional: a bad token must not block WhatsApp pairing.
  let tg = null;
  try {
    const { TelegramBot } = await import("./telegramBot.js");
    tg = new TelegramBot(wa.listSessions, wa.createSession);
    await tg.launch(15_000);
    logger.ok(`Telegram bot online${tg.botUsername ? `: @${tg.botUsername}` : ""}`);
  } catch (e) {
    logger.error("Telegram bot failed to launch (continuing without it):", e.message || String(e));
    logger.error("Check that TELEGRAM_BOT_TOKEN is valid and not revoked.");
    tg = null;
  }

  // WhatsApp
  let res;
  try {
    if (db.isSessionDisabled(cfg.owner.number)) {
      logger.info(`Owner WhatsApp session +${cfg.owner.number} is disabled from the Telegram dashboard; skipping auto-pair.`);
      res = { session: null, pairingCode: null, error: null };
    } else {
      res = await wa.createSession(cfg.owner.number, { requestPairing: true });
    }
  } catch (e) {
    res = { error: e.message };
  }
  if (res.error) {
    logger.error("Pairing failed:", res.error);
  } else if (res.pairingCode) {
    logger.ok(`Pairing code: ${res.pairingCode}`);
    if (tg) {
      for (const ownerId of cfg.telegram.ownerIds.length ? cfg.telegram.ownerIds : [cfg.telegram.adminId]) {
        try {
          await tg.send(ownerId, `🔑 𝚇𝙲𝙾𝚁𝙴® • Pairing code for +${cfg.owner.number}\n\n${res.pairingCode}`);
        } catch {
          /* the owner may not have started the bot yet */
        }
      }
    }
  }

  monitor.setNotifier(async (chatJid, text) => {
    for (const sess of [...wa.sessions.values()]) {
      try {
        await sess.sendText(chatJid, text);
        return;
      } catch {
        /* try the next session */
      }
    }
  });
  monitor.start();

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      logger.warn(`Shutdown (${sig})`);
      stopResolve();
    });
  }

  await stopped;

  monitor.stop();
  if (tg) await tg.stop();
  await server.stop();
  wa.disconnectAll();
  await sleep(300);
  runtime.hooks.exit(0);
}
