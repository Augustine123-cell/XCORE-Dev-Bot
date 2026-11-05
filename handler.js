/** Inbound message pipeline: antibug scan → name capture → prefix → role/mode gating → dispatch. */
import * as config from "../config.js";
import * as db from "../db.js";
import * as logger from "../logger.js";
import { restrictedCard } from "../format.js";
import { REGISTRY, CommandError } from "./commands/index.js";
import { inspectMessage } from "./security.js";
import { Ctx, normJid } from "./context.js";
import * as xcoreAI from "../ai/index.js";

// Commands that need premium (or sudo/owner).
const OSINT = new Set(["groups", "wafind", "agecheck", "getwadetail", "getgcdetail", "tgfind", "tgage", "tgdetail", "tggcdetail"]);
// What non-sudo users may run while the bot is in `self` mode.
const PUBLIC_ONLY = new Set(["xcore", "menu", "ping", "uptime", "support", "buypremium", "checkaccess", "health", "services", "botinfo"]);
const MAINTENANCE_OK = new Set(["health", "xcore", "menu", "support", "checkaccess", "mode", "botinfo"]);

export async function handleMessage(session, msg) {
  const cfg = config.get();

  // Anti-bug runs FIRST so a malicious message is countered before anything else touches it.
  let threat = null;
  try {
    threat = await inspectMessage(session, msg);
  } catch (e) {
    logger.error("antibug scan:", e);
  }
  if (threat && threat.handled) return;

  if (msg.pushName) {
    try {
      db.saveName(normJid(msg.sender), msg.pushName);
    } catch {
      /* names are best effort */
    }
  }

  const text = msg.text || "";
  const prefix = [...cfg.prefixes].sort((a, b) => b.length - a.length).find((p) => text.startsWith(p));
  if (prefix === undefined) {
    if (xcoreAI.shouldAutoRespond(msg, session)) {
      try {
        const answer = await xcoreAI.ask(msg.chat, xcoreAI.cleanPrompt(text));
        if (answer) await session.sendText(msg.chat, `${answer}\n\nXCORE AI`, msg.raw);
      } catch (e) {
        logger.error("XCORE AI:", e);
      }
    }
    return;
  }
  const parts = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return;
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const handler = REGISTRY.get(cmd);
  if (!handler) return;

  const number = msg.senderNumber;
  const isOwner = cfg.owner.numbers.includes(number);
  const isSudo = db.isSudo(number);
  const mode = db.getMode();

  if ((db.isRemoved(number) || db.isBanned(number)) && !isOwner) {
    await session.sendText(msg.chat, restrictedCard("Your account is banned or removed from XCORE."), msg.raw);
    return;
  }
  if ((mode === "dev" || mode === "stealth") && !isOwner) return;
  if (mode === "maintenance" && !isOwner && !MAINTENANCE_OK.has(cmd)) return;
  if (mode === "self" && !isOwner && !isSudo && !PUBLIC_ONLY.has(cmd) && cmd !== "mode") {
    await session.sendText(msg.chat, restrictedCard("This feature is restricted to the owner and SUDO users."), msg.raw);
    return;
  }

  const ctx = new Ctx({ session, msg, args, isOwner, isSudo, cmd });
  if (OSINT.has(cmd) && !(isOwner || isSudo || db.isPremium(number))) {
    await ctx.reply(restrictedCard("Premium-only feature. Use ®buypremium to request access."));
    return;
  }
  try {
    await handler(ctx);
  } catch (e) {
    // report any failure to the chat, keep the bot alive
    if (!(e instanceof CommandError)) logger.error(`/${cmd}:`, e);
    try {
      await ctx.reply(`❌ ${e.message ?? e}`);
    } catch {
      /* the chat may be unreachable */
    }
  }
}
