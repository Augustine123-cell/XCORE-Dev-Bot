/** Sudo/dev tooling: monitor, watch, apilab, api-test, scan. */
import * as api from "../../api.js";
import * as clans from "../../clans.js";
import * as config from "../../config.js";
import * as db from "../../db.js";
import { footer } from "../../format.js";
import * as http from "../../http.js";
import { UrlBlocked, assertSafeUrl } from "../../urlguard.js";
import { normJid } from "../context.js";
import { command } from "./registry.js";

const USER_AGENT = "Shadowborne/5.0";
export const ALLOWED_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);
export const LAB_METHODS = new Set([...ALLOWED_METHODS, "headers", "status"]);

const isSudo = (ctx) => ctx.isOwner || ctx.isSudo;
const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);

// ── ®monitor ────────────────────────────────────────────────────────────
command(["monitor"], async (ctx) => {
  if (!isSudo(ctx)) return ctx.reply("⛔ Sudo only.");
  const sub = (ctx.args[0] ?? "").toLowerCase();
  if (sub === "list" || !ctx.args.length) {
    const mons = db.listMonitors();
    if (!mons.length) return ctx.reply("No monitors. Add with: ®monitor <url>");
    const lines = ["✦ 𝗠𝗢𝗡𝗜𝗧𝗢𝗥𝗦", ""];
    mons.forEach((x, i) => {
      const icon = { up: "🟢", down: "🔴" }[x.status] ?? "⚪";
      lines.push(`${i + 1}. ${icon} ${x.url}`);
      if (x.lastCheck) lines.push(`   Last check: ${hhmmss(x.lastCheck)}`);
    });
    lines.push(footer(ctx.senderNumber));
    return ctx.reply(lines.join("\n"));
  }
  if (sub === "remove") {
    if (ctx.args.length < 2) return ctx.reply("Usage: ®monitor remove <url>");
    db.removeMonitor(ctx.args[1]);
    return ctx.reply(`🗑 Removed monitor: ${ctx.args[1]}${footer(ctx.senderNumber)}`);
  }
  const url = ctx.args[0];
  try {
    await assertSafeUrl(url);
  } catch (e) {
    if (e instanceof UrlBlocked) return ctx.reply(`❌ ${e.message}`);
    throw e;
  }
  if (db.addMonitor(url, ctx.chat, ctx.senderNumber)) {
    await ctx.reply(`✅ Monitoring: ${url}\nAlerts will be sent here.${footer(ctx.senderNumber)}`);
  } else {
    await ctx.reply(`⚠️ Already monitoring: ${url}${footer(ctx.senderNumber)}`);
  }
});

// ── ®watch ──────────────────────────────────────────────────────────────
command(["watch"], async (ctx) => {
  if (!isSudo(ctx)) return ctx.reply("⛔ Sudo only.");
  if (!ctx.args.length) return ctx.reply("Usage: ®watch <url>");
  const url = ctx.args[0];
  try {
    await assertSafeUrl(url);
  } catch (e) {
    if (e instanceof UrlBlocked) return ctx.reply(`❌ ${e.message}`);
    throw e;
  }
  const t = performance.now();
  let line;
  try {
    const res = await http.request("GET", url, { timeoutMs: 15_000, redirect: "manual" });
    line = `│ Status: ${res.status}`;
  } catch (e) {
    line = `│ Error: ${e.message}`;
  }
  const latency = Math.round(performance.now() - t);
  await ctx.reply(["╭──〔 𝗪𝗔𝗧𝗖𝗛 〕", `│ URL: ${url}`, line, `│ Latency: ${latency} ms`, "╰──────────────", footer(ctx.senderNumber)].join("\n"));
});

// ── ®apilab ─────────────────────────────────────────────────────────────
export async function apilab(ctx) {
  if (!isSudo(ctx)) return ctx.reply("⛔ Sudo only.");
  const method = (ctx.args[0] ?? "").toLowerCase();
  const url = ctx.args[1] ?? null;
  if (!method || !url) {
    return ctx.reply(
      [
        "✦ 𝗔𝗣𝗜 𝗟𝗔𝗕𝗢𝗥𝗔𝗧𝗢𝗥𝗬", "", "• ®apilab get <url>", "• ®apilab post <url>", "• ®apilab headers <url>",
        "• ®apilab status <url>", "• ®apilab put/delete/patch <url>",
      ].join("\n"),
    );
  }
  if (!LAB_METHODS.has(method)) return ctx.reply(`❌ Unsupported method: ${method}`);
  try {
    await assertSafeUrl(url);
  } catch (e) {
    if (e instanceof UrlBlocked) return ctx.reply(`❌ ${e.message}`);
    throw e;
  }
  const real = method === "headers" || method === "status" ? "get" : method;
  const head = ["╭───〔 𝗔𝗣𝗜 𝗜𝗡𝗦𝗣𝗘𝗖𝗧𝗢𝗥 〕"];
  const tail = ["╰────────────────────", footer(ctx.senderNumber)];
  const t = performance.now();
  let body;
  try {
    const res = await http.request(real.toUpperCase(), url, { headers: { "User-Agent": USER_AGENT }, timeoutMs: 20_000, redirect: "manual" });
    const buf = await res.arrayBuffer();
    const latency = Math.round(performance.now() - t);
    body = [
      `│ Status:  ${res.status} ${res.statusText || ""}`.trimEnd(),
      `│ Method:  ${method.toUpperCase()}`,
      `│ URL:     ${url}`,
      `│ Latency: ${latency}ms`,
      `│ Type:    ${res.headers.get("content-type") ?? "unknown"}`,
      `│ Size:    ${(buf.byteLength / 1024).toFixed(2)} KB`,
      `│ Server:  ${res.headers.get("server") ?? "—"}`,
    ];
  } catch (e) {
    body = [`│ URL: ${url}`, `│ Method: ${method.toUpperCase()}`, `│ Error: ${e.message}`];
  }
  await ctx.reply([...head, ...body, ...tail].join("\n"));
}
command(["apilab"], apilab);

// ── ®api-test ───────────────────────────────────────────────────────────
command(["api-test"], async (ctx) => {
  // Test the configured ban API once, using a dummy number rather than a real target.
  if (!isSudo(ctx)) return ctx.reply("⛔ Sudo only.");
  const cfg = config.get().api;
  const u = new URL(cfg.url);
  const safeEndpoint = `${u.protocol}//${u.host}${u.pathname}`;
  const started = performance.now();
  try {
    const result = await api.checkBan("0000000000");
    const elapsed = Math.round(performance.now() - started);
    const value = result?.banned ?? null;
    const detail =
      value === true ? "Provider returned: banned" : value === false ? "Provider returned: not banned" : "Provider responded; result format is unrecognized";
    await ctx.reply(
      ["🔌 𝚇𝙲𝙾𝚁𝙴® API TEST", "━━━━━━━━━━━━━━━━━━━━", `Endpoint: ${safeEndpoint}`, `Method: ${cfg.method}`, "Status: REACHABLE", `Latency: ${elapsed} ms`, detail, "━━━━━━━━━━━━━━━━━━━━"].join("\n"),
    );
  } catch (e) {
    // API failures must not break command processing
    const elapsed = Math.round(performance.now() - started);
    await ctx.reply(
      [
        "🔌 𝚇𝙲𝙾𝚁𝙴® API TEST", "━━━━━━━━━━━━━━━━━━━━", `Endpoint: ${safeEndpoint}`, "Status: FAILED", `Latency: ${elapsed} ms`,
        `Error: ${e.name}: ${String(e.message).slice(0, 240)}`, "Check the API URL, credentials, and provider status.",
      ].join("\n"),
    );
  }
});

// ── ®scan / ®identify ───────────────────────────────────────────────────
command(["scan", "identify"], async (ctx) => {
  if (ctx.cmd !== "identify" && !isSudo(ctx)) return ctx.reply("⛔ Sudo only. The public clan check is ®identify.");
  const sub = (ctx.args[0] ?? "").toLowerCase();
  const sn = ctx.senderNumber;

  if (sub === "list") {
    const items = clans.listClans();
    const lines = [`✦ 𝗖𝗟𝗔𝗡 𝗗𝗔𝗧𝗔𝗕𝗔𝗦𝗘 — ${items.length} entries`, ""];
    items.slice(0, 50).forEach((c, i) => lines.push(`${i + 1}. ${c.name}\n   Tag: ${c.tag}`));
    if (items.length > 50) lines.push(`… +${items.length - 50} more`);
    lines.push(footer(sn));
    return ctx.reply(lines.join("\n"));
  }

  if (sub === "add" && ctx.isOwner) {
    const payload = ctx.args.slice(1).join(" ").split("|").map((s) => s.trim());
    if (payload.length < 2) return ctx.reply("Usage: ®scan add <name> | <tag> | <description>");
    const [name, tag, ...rest] = payload;
    try {
      clans.addClan({ name, tag, description: rest[0] ?? "", members: 0, age: "unknown", threat: "UNKNOWN" });
    } catch (e) {
      return ctx.reply(`❌ ${e.message}`);
    }
    return ctx.reply(`✅ Added clan: ${name} (${tag})${footer(sn)}`);
  }

  let label;
  const quoted = ctx.msg.quotedParticipant;
  if (quoted) {
    label = db.getName(normJid(quoted)) || "Unknown";
  } else if (ctx.args.length) {
    const num = db.clean(ctx.args[0]);
    if (!num) return ctx.reply("❌ Invalid number.");
    label = db.getName(`${num}@s.whatsapp.net`) || `+${num}`;
  } else {
    return ctx.reply("Usage:\n®identify (reply)\n®identify <number>\n®scan list\n®scan add <name> | <tag> | <desc>");
  }

  const matches = clans.matchName(label);
  if (!matches.length) {
    return ctx.reply(
      ["╭──〔 𝗦𝗛𝗔𝗗𝗢𝗪 𝗦𝗖𝗔𝗡 〕", `│ Target: ${label}`, "│ Result: ❌ NOT FOUND", "│ No known clan tag matched this display name.", "╰──────────────", footer(sn)].join("\n"),
    );
  }
  const c = matches[0];
  const conf = clans.confidence(matches);
  const members = c.members;
  await ctx.reply(
    [
      "╭──〔 𝗦𝗛𝗔𝗗𝗢𝗪 𝗦𝗖𝗔𝗡 〕",
      `│ Target      : ${label}`,
      `│ Clan name   : ${c.name}`,
      `│ Clan tag    : ${c.tag}`,
      `│ member count: ${members === null || members === undefined ? "unknown" : members}`,
      `│ description : ${c.description || "—"}`,
      `│ Confidence  : ${conf}%`,
      `│ clan age    : ${c.age || "unknown"}`,
      `│ Threat      : ${c.threat || "UNKNOWN"}`,
      "╰──────────────",
      footer(sn),
    ].join("\n"),
  );
});
