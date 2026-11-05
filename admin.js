/** Owner / sudo management commands + WhatsApp group administration. */
import * as config from "../../config.js";
import * as db from "../../db.js";
import { footer } from "../../format.js";
import * as runtime from "../../runtime.js";
import { CommandError, command, requireOwner, requireSudo } from "./registry.js";
import { findParticipant, isAdmin, isSuperadmin, numberFromJid, participantJid, participants } from "../groupUtils.js";

/** JS-style `Number(v) || default` (missing, invalid or 0 → default). */
function toInt(v, def) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n !== 0 ? n : def;
}

function targetNumber(ctx) {
  const q = ctx.msg.quotedParticipant;
  const n = q ? q.split("@")[0].split(":")[0] : ctx.args[0] ?? "";
  if (!db.clean(n)) throw new CommandError("Reply to a user or provide a number.");
  return n;
}

function needNumber(value, usage) {
  if (!value || !db.clean(value)) throw new CommandError(usage);
  return value;
}

command(["sudo"], async (ctx) => {
  requireOwner(ctx);
  db.addSudo(targetNumber(ctx));
  await ctx.reply("⚔️ Sudo added.");
});

command(["delsudo"], async (ctx) => {
  requireOwner(ctx);
  db.removeSudo(targetNumber(ctx));
  await ctx.reply("⚔️ Sudo removed.");
});

command(["self"], async (ctx) => {
  requireSudo(ctx);
  db.setMode("self");
  await ctx.reply("🔒 Self mode enabled.");
});

command(["public"], async (ctx) => {
  requireSudo(ctx);
  db.setMode("public");
  await ctx.reply("🌐 Public mode enabled.");
});

export const MODES = {
  self: "👑 Owner + ⚔️ Sudo only",
  public: "🌐 Public commands enabled",
  dev: "🛠 Owner-only. Others are silent.",
  maintenance: "🔧 Only health/menu/support/checkaccess respond.",
  stealth: "🕶 Owner-only and silent to everyone else.",
};

command(["mode"], async (ctx) => {
  if (!ctx.isOwner) return ctx.reply("⛔ Owner only.");
  const target = (ctx.args[0] ?? "").toLowerCase();
  if (!target) {
    const lines = ["✦ 𝗕𝗢𝗧 𝗠𝗢𝗗𝗘", "", `Current: *${db.getMode()}*`, ""];
    for (const [k, v] of Object.entries(MODES)) lines.push(`• ®mode ${k}\n   ${v}`);
    lines.push(footer(ctx.senderNumber));
    return ctx.reply(lines.join("\n"));
  }
  if (!(target in MODES)) return ctx.reply(`❌ Unknown mode. Use: ${Object.keys(MODES).join(", ")}`);
  db.setMode(target);
  await ctx.reply(`✅ Mode → *${target}*\n${MODES[target]}${footer(ctx.senderNumber)}`);
});

command(["restart"], async (ctx) => {
  requireOwner(ctx);
  await ctx.reply("♻️ Restarting…");
  // Exit; the supervisor (Docker restart policy / PM2 / Railway / systemd) starts a fresh process.
  setTimeout(() => runtime.hooks.exit(0), 500);
});

command(["premium"], async (ctx) => {
  requireOwner(ctx);
  const a = (ctx.args[0] ?? "").toLowerCase();
  if (a === "add") {
    const n = needNumber(ctx.args[1], "Usage: ®premium add <number> <days>");
    db.addPremium(n, toInt(ctx.args[2], 30), "standard", ctx.senderNumber);
    return ctx.reply("💎 Premium added.");
  }
  if (a === "remove") {
    db.removePremium(needNumber(ctx.args[1], "Usage: ®premium remove <number>"));
    return ctx.reply("💎 Premium removed.");
  }
  if (a === "list") {
    const rows = db.listPremium().map((x) => `+${x.number} • ${x.plan} • ${x.daysLeft} days`);
    return ctx.reply(rows.join("\n") || "None");
  }
  throw new CommandError("Usage: ®premium add|remove|list");
});

command(["ban"], async (ctx) => {
  // In groups, ®ban removes the target from that group. In private chat it retains
  // the legacy local access-ban behaviour; use ®localban explicitly if desired.
  if (String(ctx.chat).endsWith("@g.us")) return groupRemove(ctx);
  requireOwner(ctx);
  if (!ctx.args.length) throw new CommandError("Usage: ®ban <number> <days|0> [reason]");
  db.banUser(ctx.args[0], toInt(ctx.args[1], 0), ctx.args.slice(2).join(" ") || "No reason", ctx.senderNumber);
  await ctx.reply("🚫 Local ban added to User.");
});

command(["localban"], async (ctx) => {
  requireOwner(ctx);
  if (!ctx.args.length) throw new CommandError("Usage: ®localban <number> <days|0> [reason]");
  db.banUser(ctx.args[0], toInt(ctx.args[1], 0), ctx.args.slice(2).join(" ") || "No reason", ctx.senderNumber);
  await ctx.reply("🚫 Local ban added to User.");
});

command(["unban"], async (ctx) => {
  requireOwner(ctx);
  if (!ctx.args.length) throw new CommandError("Usage: ®unban <number>");
  db.unbanUser(ctx.args[0]);
  await ctx.reply("✅ Local ban removed.");
});

command(["remove"], async (ctx) => {
  requireOwner(ctx);
  if (!ctx.args.length) throw new CommandError("Usage: ®remove <number>");
  db.removeUser(ctx.args[0]);
  await ctx.reply("⛔ User removed from local bot access.");
});

command(["restore"], async (ctx) => {
  requireOwner(ctx);
  if (!ctx.args.length) throw new CommandError("Usage: ®restore <number>");
  db.restoreUser(ctx.args[0]);
  await ctx.reply("✅ User access restored.");
});

command(["banned"], async (ctx) => {
  requireOwner(ctx);
  const rows = db.listBanned().map((x) => `+${x.number} • ${x.daysLeft} • ${x.reason}`);
  await ctx.reply(rows.join("\n") || "No locally banned users.");
});

command(["antiban"], async (ctx) => {
  requireSudo(ctx);
  const v = (ctx.args[0] ?? "").toLowerCase();
  if (v !== "on" && v !== "off") return ctx.reply(`🛡 Antiban: ${db.getAntiban() ? "ON" : "OFF"}`);
  db.setAntiban(v === "on");
  await ctx.reply(`🛡 Antiban ${v.toUpperCase()}.`);
});

const LEVELS = { low: 75, normal: 60, high: 45 };
const onoff = (v) => (v ? "ON" : "OFF");
const levelName = (threshold) => Object.entries(LEVELS).find(([, v]) => v === threshold)?.[0] ?? `custom (${threshold})`;

command(["antibug"], async (ctx) => {
  // ®antibug [log|status|on|off|block on/off|purge on/off|level low/normal/high|trust N|untrust N|unblock N|list]
  requireSudo(ctx);
  const sub = (ctx.args[0] ?? "log").toLowerCase();
  const arg = ctx.args[1] ?? "";
  const cfg = db.antibugSettings();

  if (sub === "on" || sub === "off") {
    db.setAntibugOption("enabled", sub === "on");
    return ctx.reply(`🛡 Antibug protection ${sub.toUpperCase()}.`);
  }
  if (sub === "block" || sub === "purge") {
    if (!["on", "off"].includes(arg.toLowerCase())) return ctx.reply(`🛡 Auto-${sub}: ${onoff(cfg["auto" + sub])}. Use ®antibug ${sub} on|off`);
    db.setAntibugOption("auto" + sub, arg.toLowerCase() === "on");
    return ctx.reply(`🛡 Auto-${sub} ${arg.toUpperCase()}.`);
  }
  if (sub === "level") {
    if (!(arg.toLowerCase() in LEVELS)) return ctx.reply(`🛡 Sensitivity: ${levelName(cfg.threshold)}. Use ®antibug level low|normal|high`);
    db.setAntibugOption("threshold", LEVELS[arg.toLowerCase()]);
    return ctx.reply(`🛡 Sensitivity set to ${arg.toLowerCase()} (counter at strength ≥ ${LEVELS[arg.toLowerCase()]}).`);
  }
  if (sub === "trust" || sub === "untrust") {
    const number = db.clean(needNumber(arg, `Usage: ®antibug ${sub} <number>`));
    db.antibugTrust(number, sub === "trust");
    return ctx.reply(`🛡 +${number} ${sub === "trust" ? "trusted — never scanned for countermeasures" : "no longer trusted"}.`);
  }
  if (sub === "unblock") {
    const number = db.clean(needNumber(arg, "Usage: ®antibug unblock <number>"));
    const wasShielded = db.antibugShieldRemove(number);
    let note = "";
    if (typeof ctx.session.unblockContact === "function") {
      try {
        await ctx.session.unblockContact(`${number}@s.whatsapp.net`);
        note = " WhatsApp block lifted.";
      } catch (exc) {
        note = ` (WhatsApp unblock failed: ${exc.message ?? exc})`;
      }
    }
    return ctx.reply(`🛡 +${number} ${wasShielded ? "removed from the shield" : "was not in the shield"}.${note}`);
  }
  if (sub === "list") {
    const rows = Object.entries(db.antibugShieldList()).map(
      ([n, v]) => `+${n} • ${v.strength ?? "?"}/100 • ${v.reason} • ${v.waBlocked ? "WA-blocked" : "bot-shield only"}`,
    );
    return ctx.reply(rows.join("\n") || "Shield is empty.");
  }
  if (sub === "status") {
    const bugs = db.listBugs(200);
    const countered = bugs.filter((b) => b.action === "countered");
    const avg = countered.length ? Math.round(countered.reduce((a, b) => a + (b.effectiveness ?? 0), 0) / countered.length) : null;
    return ctx.reply(
      "🛡 ANTIBUG STATUS\n\n" +
        `Protection: ${onoff(cfg.enabled)}\nAuto-block: ${onoff(cfg.autoblock)}\nAuto-purge: ${onoff(cfg.autopurge)}\n` +
        `Sensitivity: ${levelName(cfg.threshold)}\nShielded attackers: ${Object.keys(cfg.blocked).length}\nTrusted numbers: ${cfg.trusted.length}\n` +
        `Attacks countered (last 200 events): ${countered.length}\n` +
        `Average effectiveness: ${avg === null ? "n/a" : `${avg}%`}`,
    );
  }

  const row = (x) => {
    const stamp = new Date(x.at).toISOString();
    let extra = "";
    if ("strength" in x) {
      extra = ` • ${x.strength}/100`;
      if (x.action === "countered") extra += ` • effectiveness ${x.effectiveness ?? 0}%`;
      else if (x.action) extra += ` • ${x.action}`;
    }
    return `${stamp} • ${x.sender} • ${x.reason}${extra}`;
  };
  await ctx.reply(db.listBugs(10).map(row).join("\n") || "No alerts.");
});

// ── WhatsApp group administration ──────────────────────────────────────
const PENDING_SWEEPS = new Map(); // chat → [deadline (s), numbers]
const monotonic = () => performance.now() / 1000;

function targetGroupNumber(ctx) {
  const quoted = ctx.msg.quotedParticipant;
  const raw = quoted ? quoted.split("@")[0].split(":")[0] : ctx.args[0] ?? "";
  const number = String(raw).replace(/\D/g, "");
  if (number.length < 7 || number.length > 15) throw new CommandError("Reply to a member or provide an international phone number.");
  return number;
}

async function groupMetadata(ctx) {
  if (!String(ctx.chat).endsWith("@g.us")) throw new CommandError("This command must be used inside a WhatsApp group.");
  if (typeof ctx.session.groupInfo !== "function") throw new CommandError("Group metadata is unavailable in this WhatsApp connection.");
  try {
    return await ctx.session.groupInfo(ctx.chat);
  } catch (exc) {
    throw new CommandError(`Could not retrieve group information: ${String(exc.message ?? exc).slice(0, 180)}`);
  }
}

function requireBotAdmin(ctx, info) {
  const bot = findParticipant(info, ctx.session.number);
  if (!bot || !isAdmin(bot)) throw new CommandError("The connected WhatsApp account must be a group administrator.");
}

function requireGroupOperator(ctx, info, ownerOnly = false) {
  requireBotAdmin(ctx, info);
  if (ownerOnly) return requireOwner(ctx);
  if (ctx.isOwner || ctx.isSudo) return;
  const member = findParticipant(info, ctx.senderNumber);
  if (!member || !isAdmin(member)) throw new CommandError("Only the bot owner, SUDO, or a group administrator can use this command.");
}

async function changeParticipant(ctx, number, action) {
  const info = await groupMetadata(ctx);
  requireGroupOperator(ctx, info, action === "remove_admin");
  const target = findParticipant(info, number);
  if (!target) throw new CommandError("Target is not a member of this group.");
  if (isSuperadmin(target)) throw new CommandError("The group creator cannot be modified by the bot.");
  if (config.get().owner.numbers.includes(number) && ["remove", "demote"].includes(action)) {
    throw new CommandError("Registered XCORE owner numbers are protected.");
  }
  if (number === ctx.session.number) throw new CommandError("The bot's own account is protected.");
  try {
    await ctx.session.groupParticipants(ctx.chat, [number], { promote: "promote", demote: "demote", remove: "remove" }[action]);
  } catch (exc) {
    throw new CommandError(`WhatsApp rejected the operation: ${String(exc.message ?? exc).slice(0, 200)}`);
  }
  return number;
}

async function groupRemove(ctx) {
  const number = targetGroupNumber(ctx);
  await changeParticipant(ctx, number, "remove");
  await ctx.reply(`🚫 Removed +${number} from this group.`);
}

command(["ordain", "promote"], async (ctx) => {
  const number = targetGroupNumber(ctx);
  await changeParticipant(ctx, number, "promote");
  await ctx.reply(`👑 +${number} has been promoted to group administrator.`);
});

command(["strip", "demote"], async (ctx) => {
  const number = targetGroupNumber(ctx);
  await changeParticipant(ctx, number, "demote");
  await ctx.reply(`⚔️ Administrator privileges removed from +${number}.`);
});

command(["jid"], async (ctx) => {
  await groupMetadata(ctx);
  await ctx.reply(`🆔 GROUP JID\n${ctx.chat}`);
});

command(["purge"], async (ctx) => {
  const info = await groupMetadata(ctx);
  requireGroupOperator(ctx, info, true);
  const owners = config.get().owner.numbers;
  const targets = [];
  for (const member of participants(info)) {
    const number = numberFromJid(participantJid(member));
    if (!number || !isAdmin(member) || isSuperadmin(member)) continue;
    if (number === ctx.session.number || owners.includes(number)) continue;
    targets.push(number);
  }
  if (!targets.length) return ctx.reply("✅ No eligible administrators to demote. The group creator and protected owners are untouched.");
  let done = 0;
  const failed = [];
  for (const number of targets) {
    try {
      await ctx.session.groupParticipants(ctx.chat, [number], "demote");
      done += 1;
    } catch {
      failed.push(number);
    }
  }
  await ctx.reply(`⚔️ ADMIN PURGE COMPLETE\nDemoted: ${done}\nFailed: ${failed.length}\nProtected: group creator, bot and registered owners.`);
});

command(["sweepclean"], async (ctx) => {
  requireOwner(ctx);
  const info = await groupMetadata(ctx);
  requireBotAdmin(ctx, info);
  const key = ctx.chat;
  const owners = config.get().owner.numbers;
  if (!ctx.args.length || ctx.args[0].toLowerCase() !== "confirm") {
    const targets = [];
    for (const member of participants(info)) {
      const number = numberFromJid(participantJid(member));
      if (!number || number === ctx.session.number || owners.includes(number)) continue;
      // Keep group admins by default so a cleanup cannot unexpectedly strip the
      // group's leadership; group creator is never removable.
      if (isAdmin(member) || isSuperadmin(member)) continue;
      targets.push(number);
    }
    PENDING_SWEEPS.set(key, [monotonic() + 60, targets]);
    return ctx.reply(
      "⚠️ SWEEPCLEAN PREVIEW\n" +
        `Eligible members to remove: ${targets.length}\n` +
        "Protected: bot, registered XCORE owners, group administrators and group creator.\n\n" +
        "To proceed within 60 seconds, send ®sweepclean confirm.",
    );
  }
  const pending = PENDING_SWEEPS.get(key);
  if (!pending || pending[0] < monotonic()) {
    PENDING_SWEEPS.delete(key);
    throw new CommandError("No active sweep confirmation. Run ®sweepclean to preview first.");
  }
  PENDING_SWEEPS.delete(key);
  let done = 0;
  const failed = [];
  for (const number of pending[1]) {
    try {
      await ctx.session.groupParticipants(ctx.chat, [number], "remove");
      done += 1;
    } catch {
      failed.push(number);
    }
  }
  await ctx.reply(`🧹 SWEEPCLEAN COMPLETE\nRemoved: ${done}\nFailed: ${failed.length}\nProtected admins, owners and bot were retained.`);
});

command(["expel"], async (ctx) => {
  // Remove the replied-to group member (or supplied number), with normal admin protections.
  await groupRemove(ctx);
});
