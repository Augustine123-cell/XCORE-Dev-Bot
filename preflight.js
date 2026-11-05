/** Deployment preflight: validate required configuration and installed integration surfaces. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as config from "./config.js";

export async function main(print = console.log) {
  print("╭━━━〔 𝚇𝙲𝙾𝚁𝙴® 〕━━━╮");
  print("DEPLOYMENT PREFLIGHT — Developer: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽");
  const errors = [];
  const warnings = [];

  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 12)) errors.push(`Node ${process.versions.node} is too old; need 20.12 or newer.`);
  else print(`[OK] Node ${process.versions.node}`);

  let cfg = null;
  try {
    cfg = config.get();
    print(`[OK] Configuration loaded | WhatsApp owners: ${cfg.owner.numbers.length} | Telegram owners: ${cfg.telegram.ownerIds.length}`);
    print(`[OK] Command prefixes: ${cfg.prefixes.join(" / ")}`);
    print(`[INFO] Telegram Stars plans: 30d=${cfg.telegram.premium30dStars} XTR, 365d=${cfg.telegram.premium365dStars} XTR`);
    if (!cfg.telegram.premium30dStars && !cfg.telegram.premium365dStars) warnings.push("Telegram /buy is disabled until at least one PREMIUM_*_STARS price is set.");
    if (cfg.bot.mode !== "public") warnings.push("BOT_MODE is not public; ordinary paid users may be blocked from most commands.");
  } catch (exc) {
    errors.push(`Configuration: ${exc.name}: ${exc.message}`);
  }

  try {
    const mod = await import("@whiskeysockets/baileys");
    const make = mod.default?.default ?? mod.default ?? mod.makeWASocket;
    const missing = ["useMultiFileAuthState", "DisconnectReason", "downloadMediaMessage"].filter((n) => mod[n] === undefined);
    if (typeof make !== "function") errors.push("Baileys: makeWASocket export not found");
    else if (missing.length) errors.push(`Baileys is missing exports: ${missing.join(", ")}`);
    else print("[OK] Dependency: @whiskeysockets/baileys");
  } catch (exc) {
    errors.push(`Dependency @whiskeysockets/baileys: ${exc.name}: ${exc.message}`);
  }
  for (const dep of ["pino", "jimp", "jsqr"]) {
    try {
      await import(dep);
      print(`[OK] Dependency: ${dep}`);
    } catch {
      warnings.push(`Optional dependency ${dep} is not installed${dep === "pino" ? "" : " (®readqr will not work)"}.`);
    }
  }
  if (spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0) warnings.push("git is not installed; ®gitclone will not work.");

  if (cfg) {
    if (!fs.existsSync(String(cfg.paths.sessions))) warnings.push(`Session directory will be created: ${cfg.paths.sessions}`);
    if (!(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.PERSIST_DIR || process.env.DATA_DIR)) {
      warnings.push("No persistent-volume environment detected; WhatsApp sessions may be lost on redeploy.");
    }
  }

  for (const w of warnings) print(`[WARN] ${w}`);
  for (const e of errors) print(`[FAIL] ${e}`);
  print("╰━━━━━━━━━━━━━━━━━━╯");
  print("Developer: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽");
  return errors.length ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code));
}
