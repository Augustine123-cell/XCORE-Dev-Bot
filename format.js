/** Message cards and the menu. */
import { clean, getMode, getRole, listBanned, listPremium } from "./db.js";

export const BANNER = ["╭━━━〔 𝚇𝙲𝙾𝚁𝙴® 〕━━━╮"];
export const BRAND_HEADER = "╭━━━〔 𝚇𝙲𝙾𝚁𝙴® 〕━━━╮";
export const BRAND_FOOTER = "╰━━━━━━━━━━━━━━━━━━╯\nDeveloper: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽\nSHΔDOWBORNE LΔB 𝚇𝙲𝙾𝚁𝙴®";
export const DEV_CREDIT = "Developer: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽";

/** Apply the official XCORE header/footer once to every outgoing bot message. */
export function brandMessage(text) {
  let value = String(text ?? "").trim();
  if (!value.startsWith(BRAND_HEADER)) value = value ? `${BRAND_HEADER}\n\n${value}` : BRAND_HEADER;
  if (!value.includes(DEV_CREDIT)) value = `${value.trimEnd()}\n\n${BRAND_FOOTER}`;
  return value;
}

/** Local date/time like "2026-11-03 14:05:09 WAT" (the Python bot used strftime with %Z). */
export function localStamp(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23", timeZoneName: "short",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

const BADGES = {
  OWNER: "👑 OWNER",
  SUDO: "⚔️ SUDO",
  PREMIUM: "💎 PREMIUM",
  PAIRED: "🔗 PAIRED",
  USER: "👤 USER",
  BANNED: "🚫 BANNED",
  REMOVED: "⛔ REMOVED",
};

export function footer(n) {
  const badge = BADGES[getRole(n)] ?? "👤 USER";
  return [
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `${badge} • +${n}`,
    "Developer: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽",
    "SHΔDOWBORNE LΔB 𝚇𝙲𝙾𝚁𝙴®",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━",
  ].join("\n");
}

export function menu(n) {
  const role = getRole(n);
  const mode = getMode();
  const premium = ["OWNER", "SUDO", "PREMIUM"].includes(role);
  const owner = role === "OWNER";
  const sudo = ["OWNER", "SUDO"].includes(role);
  const L = [
    ...BANNER, "", "💨 𝚇𝙲𝙾𝚁𝙴® 𝗦𝗬𝗦𝗧𝗘𝗠 𝗖𝗢𝗡𝗦𝗢𝗟𝗘", "",
    `┃ ✦ 𝗠𝗢𝗗𝗘: ${mode.toUpperCase()}`, `┃ ✦ ACCESS: ${role}`, "┃ ✦ PREFIX: ®  |  @", "",
    "╭━━━━━━〔 𝗔𝗖𝗖𝗢𝗨𝗡𝗧 / 𝗗𝗘𝗩𝗜𝗖𝗘 〕",
    "┃ ✞ ®bancheck <number>", "┃ ✞ ®device [number]", "┃ ✞ ®clientid [number]",
    "┃ ✞ ®clientcheck [number]", "┃ ✞ ®get-id", "┃ ✞ ®identify (reply/number)", "┃ ✞ ®session", "╰━━━━━━━━━━━━━━━━━━", "",
    "╭━━━━━━〔 𝗦𝗘𝗖𝗨𝗥𝗜𝗧𝗬 〕", "┃ ✞ ®antibug (log)  ®antibug status", "┃ ✞ ®antibug on|off  block|purge on|off  level low|normal|high",
    "┃ ✞ ®antibug trust|untrust|unblock <number>  list",
    "┃ ✞ Bug detection scored 0-100 → auto-block, purge, shield, effectiveness %", "╰━━━━━━━━━━━━━━━━━━", "",
    "╭━━━━━━〔 𝗚𝗥𝗢𝗨𝗣 𝗖𝗢𝗡𝗧𝗥𝗢𝗟 〕", "┃ ✞ ®ban", "┃ ✞ ®ordain / ®strip",
    "┃ ✞ ®expel (reply to member)", "┃ ✞ ®jid", "┃ ✞ ®sweepclean (owner; confirmation)",
    "┃ ✞ ®purge (owner)", "╰━━━━━━━━━━━━━━━━━━", "",
    "╭━━━━━━〔 𝗨𝗧𝗜𝗟𝗜𝗧𝗜𝗘𝗦 〕", "┃ ✞ ®save contact <tag> <number>",
    "┃ ✞ ®save contact <tag> (reply)", "┃ ✞ ®readqr (reply to QR image)", "╰━━━━━━━━━━━━━━━━━━", "",
  ];
  if (sudo) {
    L.push(
      "╭━━━━━━〔 𝗗𝗘𝗩𝗘𝗟𝗢𝗣𝗘𝗥 𝗧𝗢𝗢𝗟𝗦 〕", "┃ ✞ ®gitclone <HTTPS repository URL>",
      "┃ ✞ ®mediafire <public download link>", "┃ ✞ ®apify help / actors / me",
      "┃ ✞ ®apify run <alias> <JSON>", "┃ ✞ ®apilab get <url>", "┃ ✞ ®watch <url>",
      "┃ ✞ ®monitor <url> / list / remove", "╰━━━━━━━━━━━━━━━━━━", "",
    );
  }
  if (premium) {
    L.push(
      "╭━━━━━━〔 𝗢𝗦𝗜𝗡𝗧 〕", "┃ ✞ ®groups <keyword> [country] [max]",
      "┃ ✞ ®wafind <keyword>", "┃ ✞ ®getwadetail <number>", "┃ ✞ ®getgcdetail <jid>",
      "┃ ✞ ®agecheck <number>", "┃ ✞ ®tgfind <keyword>", "┃ ✞ ®tgdetail <@user>",
      "┃ ✞ ®tggcdetail <@channel>", "┃ ✞ ®tgage <id>", "╰━━━━━━━━━━━━━━━━━━", "",
    );
  } else {
    L.push("╭━━━━━━〔 𝗢𝗦𝗜𝗡𝗧 · 𝗣𝗥𝗘𝗠𝗜𝗨𝗠 〕", "┃ ✞ 🔒 ®buypremium (Buy premium)", "╰━━━━━━━━━━━━━━━━━━", "");
  }
  L.push(
    "╭━━━━━━〔 𝗦𝗬𝗦𝗧𝗘𝗠 〕", "┃ ✞ ®ping", "┃ ✞ ®botinfo", "┃ ✞ ®health",
    "┃ ✞ ®services", "┃ ✞ ®stats", "┃ ✞ ®uptime", "┃ ✞ ®checkaccess", "╰━━━━━━━━━━━━━━━━━━", "",
  );
  if (owner) {
    L.push(
      "╭━━━━━━〔 𝗢𝗪𝗡𝗘𝗥 𝗖𝗢𝗡𝗧𝗥𝗢𝗟 〕", "┃ ✞ ®sudo / ®delsudo (reply)",
      "┃ ✞ ®premium add|remove|list", "┃ ✞ ®localban / ®unban", "┃ ✞ ®remove / ®restore",
      "┃ ✞ ®banned", "┃ ✞ ®restart", "┃ ✞ ®scan (reply)", "┃ ✞ ®restore <number>", "╰━━━━━━━━━━━━━━━━━━", "",
    );
  }
  L.push("JUST Δ LITTLE UNIMΔGINΔΔRY", footer(n));
  return L.join("\n");
}

export function restrictedCard(reason = "This command is not available to your account.") {
  return [
    "╭━━━〔 𝚇𝙲𝙾𝚁𝙴® 〕━━━╮", "", "RESTRICTED ACCESS ✘",
    "╭────────────────────╮", "┃  ACCESS DENIED", `┃  ${reason.slice(0, 180)}`,
    "┃  Contact the bot owner for access.", "╰────────────────────╯", "",
    "𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽 · SHΔDOWBORNE LΔB",
  ].join("\n");
}

const REGIONS = {
  "234": "NG (+234)",
  "233": "GH (+233)",
  "254": "KE (+254)",
  "27": "ZA (+27)",
  "44": "UK (+44)",
  "1": "US (+1)",
};

export function region(p) {
  const d = String(p ?? "").replace(/\D/g, "");
  for (const length of [3, 2, 1]) {
    // longest dial-code prefix wins
    const prefix = d.slice(0, length);
    if (prefix.length === length && prefix in REGIONS) return REGIONS[prefix];
  }
  return "Unknown";
}

export function banCard(p, r, n) {
  const st = r.banned === true ? "🔴 BANNED" : r.banned === false ? "🟢 NOT BANNED" : "⚠️ UNKNOWN";
  return [
    "*𝚇𝙲𝙾𝚁𝙴® WHATSAPP BAN CHECK*",
    "",
    `Target: ${p}`,
    `Region: ${region(p)}`,
    `Status: ${st}`,
    `Reason: ${r.reason || "No reason provided"}`,
    footer(n),
  ].join("\n");
}

export function deviceCard(i, n) {
  return [
    ...BANNER,
    "",
    "✦ 𝗗𝗘𝗩𝗜𝗖𝗘 𝗜𝗡𝗙𝗢",
    "",
    `Name: ${i.name || "ANDROID"}`,
    `Platform: ${i.platform || "Unknown"}`,
    `Version: ${i.version || "UNAVAILABLE"}`,
    `OS Build: ${i.os || "iOS"}`,
    footer(n),
  ].join("\n");
}

export function accessCard(n) {
  const role = getRole(n);
  const c = clean(n);
  const L = [...BANNER, "", "✦ 𝗔𝗖𝗖𝗘𝗦𝗦 𝗦𝗧𝗔𝗧𝗨𝗦", "", `Number: +${n}`, `Role: ${role}`];
  if (role === "BANNED") {
    const b = listBanned().find((x) => x.number === c) || {};
    const left = b.daysLeft;
    L.push(`Reason: ${b.reason || "N/A"}`);
    L.push(`Until: ${left === "permanent" ? "Permanent" : `${left} days`}`);
  }
  if (role === "PREMIUM") {
    const p = listPremium().find((x) => x.number === c);
    if (p) L.push(`Plan: ${p.plan} (${p.daysLeft} days left)`);
  }
  L.push(footer(n));
  return L.join("\n");
}
