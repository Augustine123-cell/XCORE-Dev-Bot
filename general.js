/** Everyday commands available to (almost) everyone. */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as api from "../../api.js";
import * as config from "../../config.js";
import * as db from "../../db.js";
import * as fmt from "../../format.js";
import * as runtime from "../../runtime.js";
import { listSessions } from "../state.js";
import { CommandError, command } from "./registry.js";
import { apilab, LAB_METHODS } from "./devtools.js";

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");

export function prettyJson(data, limit = 3500) {
  const s = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  return (s ?? String(data)).slice(0, limit);
}

const validTarget = (t) => t.length >= 7 && t.length <= 15;
const digits = (s) => String(s ?? "").replace(/\D/g, "");

command(["menu"], async (ctx) => {
  await ctx.reply(fmt.menu(ctx.senderNumber));
});

command(["xcore"], async (ctx) => {
  const image = path.join(ASSETS, "xcore-brand.png");
  const soundtrack = path.join(ASSETS, "xcore-id.mp3");
  if (!fs.existsSync(image) || !fs.existsSync(soundtrack)) throw new CommandError("XCORE startup assets are missing from this installation.");
  if (typeof ctx.session.sendImage !== "function" || typeof ctx.session.sendAudio !== "function") {
    throw new CommandError("This WhatsApp connection does not support the required startup media methods.");
  }
  await ctx.session.sendImage(ctx.chat, image, "XCORE® | WhatsApp Dev Bot\nAUTOMATE • CONTROL • DOMINATE");
  const identity =
    "╔══════════════════════════════════════╗\n" +
    "║              XCORE®                  ║\n" +
    "║       WHATSAPP DEV BOT               ║\n" +
    "╚══════════════════════════════════════╝\n\n" +
    "╭━━━〔 XCORE® 〕━━━╮\n" +
    "┃ PROJECT SHΔDOW\n" +
    "┃ Developer: DEV AUSTIN\n" +
    "┃ Laboratory: SHΔDOWBORNE LΔB\n" +
    "┃ Technology: XCORE®\n" +
    `┃ Date & Time: ${fmt.localStamp()}\n` +
    "╰━━━━━━━━━━━━━━━━━━╯\n" +
    "JUST Δ LITTLE UNIMΔGINΔΔRY";
  await ctx.reply(identity);
  await ctx.session.sendAudio(ctx.chat, soundtrack, "XCORE® — Official Startup Soundtrack");
  await ctx.reply(fmt.menu(ctx.senderNumber));
});

command(["botinfo"], async (ctx) => {
  await ctx.reply(
    [
      "╭━━━〔 𝚇𝙲𝙾𝚁𝙴® 〕━━━╮",
      "",
      "PROJECT SHΔDOW",
      "Developer: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽",
      "Laboratory: SHΔDOWBORNE LΔB",
      "Technology: 𝚇𝙲𝙾𝚁𝙴®",
      `Date & Time: ${fmt.localStamp()}`,
      "",
      "JUST Δ LITTLE UNIMΔGINΔΔRY",
    ].join("\n"),
  );
});

command(["ping"], async (ctx) => {
  await ctx.reply("🏓 PONG");
});

command(["getid", "get-id"], async (ctx) => {
  await ctx.reply(`🆔 Chat: ${ctx.chat}\n👤 Sender: ${ctx.sender}\n📱 Number: +${ctx.senderNumber}`);
});

command(["device"], async (ctx) => {
  const target = digits(ctx.args[0] ?? ctx.senderNumber);
  if (!validTarget(target)) throw new CommandError("Usage: ®device [international-number]");
  let result = null;
  if (typeof ctx.session.userDevices === "function") {
    try {
      result = await ctx.session.userDevices(target);
    } catch (exc) {
      result = `Unavailable: ${String(exc.message ?? exc).slice(0, 180)}`;
    }
  }
  const host = `${os.type()} ${os.release()} / Node ${process.versions.node}`;
  const payload = result !== null ? prettyJson(result, 1800) : "WhatsApp did not expose linked-device metadata.";
  await ctx.reply(
    "╭━━━〔 𝚇𝙲𝙾𝚁𝙴® 〕━━━╮\n\n" +
      "📱 DEVICE / CLIENT INSPECTION\n" +
      `Target: +${target}\n` +
      `Linked-device data: ${payload}\n` +
      `Bot host runtime: ${host}\n\n` +
      "The host runtime is not the target's phone OS. Android/iOS is reported only when WhatsApp exposes reliable metadata.",
  );
});

command(["clientid", "client-id"], async (ctx) => {
  const target = digits(ctx.args[0] ?? ctx.senderNumber);
  if (!validTarget(target)) throw new CommandError("Usage: ®clientid [international-number]");
  if (typeof ctx.session.userDevices !== "function") throw new CommandError("Client/device identifiers are not exposed by this connection.");
  let result;
  try {
    result = await ctx.session.userDevices(target);
  } catch (exc) {
    throw new CommandError(`Client ID lookup unavailable: ${String(exc.message ?? exc).slice(0, 180)}`);
  }
  await ctx.reply(`🆔 CLIENT IDENTIFIERS\nTarget: +${target}\n${prettyJson(result, 2500)}`);
});

command(["clientcheck", "client-check"], async (ctx) => {
  const target = digits(ctx.args[0] ?? ctx.senderNumber);
  if (!validTarget(target)) throw new CommandError("Usage: ®clientcheck [international-number]");
  if (typeof ctx.session.isOnWhatsapp !== "function") throw new CommandError("WhatsApp client verification is unavailable in this library version.");
  let result;
  try {
    result = await ctx.session.isOnWhatsapp(target);
  } catch (exc) {
    throw new CommandError(`Client check failed: ${String(exc.message ?? exc).slice(0, 180)}`);
  }
  await ctx.reply(`🔎 CLIENT CHECK\nTarget: +${target}\nResult: ${prettyJson(result, 1800)}`);
});

command(["session"], async (ctx) => {
  const s = listSessions();
  await ctx.reply(`🔗 Active sessions: ${s.length}\n` + (s.map((x) => `• +${x}`).join("\n") || "None"));
});

command(["stats"], async (ctx) => {
  const s = db.getStats();
  await ctx.reply(`📊 STATS\nChecks: ${s.checks}\nBanned: ${s.banned}\nSafe: ${s.safe}`);
});

command(["uptime"], async (ctx) => {
  await ctx.reply(`⏱ UPTIME\n${runtime.uptimeSeconds()} seconds`);
});

command(["support"], async (ctx) => {
  await ctx.reply(`🛠 SUPPORT\nContact: +${config.get().owner.number}`);
});

command(["buypremium"], async (ctx) => {
  await ctx.reply(`💎 PREMIUM\nContact +${config.get().owner.number}`);
});

command(["checkaccess"], async (ctx) => {
  await ctx.reply(fmt.accessCard(ctx.senderNumber));
});

command(["bancheck"], async (ctx) => {
  let phone;
  try {
    phone = api.normalizePhone(ctx.args[0] ?? "");
  } catch (e) {
    throw new CommandError(e.message);
  }
  const result = await api.checkBan(phone);
  db.bumpStats(result.banned);
  await ctx.reply(fmt.banCard(phone, result, ctx.senderNumber));
});

command(["api"], async (ctx) => {
  if (ctx.args.length && LAB_METHODS.has(ctx.args[0].toLowerCase())) return apilab(ctx);
  const cfg = config.get().api;
  await ctx.reply(`🌐 API\n${cfg.url}\nMethod: ${cfg.method}`);
});

command(["health"], async (ctx) => {
  const cfg = config.get();
  const s = db.getStats();
  const mons = db.listMonitors();
  const up = mons.filter((x) => x.status === "up").length;
  const down = mons.filter((x) => x.status === "down").length;
  await ctx.reply(
    [
      "╭──〔 𝗛𝗘𝗔𝗟𝗧𝗛 〕",
      `│ Bot:       ${cfg.bot.name}`,
      `│ Mode:      ${db.getMode()}`,
      `│ Uptime:    ${runtime.uptimeSeconds()}s`,
      `│ Sessions:  ${listSessions().length}`,
      `│ Checks:    ${s.checks} (${s.banned} banned / ${s.safe} safe)`,
      `│ Monitors:  ${mons.length} (🟢 ${up} / 🔴 ${down})`,
      "╰──────────────",
      fmt.footer(ctx.senderNumber),
    ].join("\n"),
  );
});

command(["services"], async (ctx) => {
  const mons = db.listMonitors();
  if (!mons.length) return ctx.reply("No services monitored.");
  const lines = ["╭──〔 𝗦𝗘𝗥𝗩𝗜𝗖𝗘𝗦 〕", ""];
  for (const x of mons) {
    const icon = { up: "🟢", down: "🔴" }[x.status] ?? "⚪";
    lines.push(`│ ${icon} ${x.url}`, `│    checks: ${x.totalChecks ?? 0}  downs: ${x.totalDown ?? 0}`);
    if (x.downSince) lines.push(`│    down for: ${Math.floor((db.nowMs() - x.downSince) / 1000)}s`);
    lines.push("");
  }
  lines.push("╰──────────────", fmt.footer(ctx.senderNumber));
  await ctx.reply(lines.join("\n"));
});
