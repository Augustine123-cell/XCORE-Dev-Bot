/**
 * XCORE Anti-Bug engine.
 *
 * Pipeline for every inbound message (DMs and groups):
 *
 *   1. Shield   – numbers already countered are dropped instantly.
 *   2. Analyse  – payload signals (size, control/invisible/combining characters, mass mentions,
 *                 oversized protobuf, unparseable events …) + behaviour signals (flood, duplicates)
 *                 are scored into a 0-100 **bug strength**.
 *   3. Counter  – at or above the threshold: block the sender on WhatsApp, purge every message
 *                 we saw from them, add them to the bot-level shield, alert the owner.
 *   4. Report   – the owner receives the strength and an **effectiveness %** computed only from
 *                 actions that really succeeded (nothing is assumed).
 *
 * Group behaviour from the previous version is kept: when the bot is a group admin it also deletes
 * the messages and applies the 30-minute soft mute.
 */
import { createHash } from "node:crypto";
import * as config from "../config.js";
import * as db from "../db.js";
import * as logger from "../logger.js";
import { NotImplementedError } from "../errors.js";
import { findParticipant, isAdmin } from "./groupUtils.js";

// ── runtime state (short-lived; persistent state lives in db.json) ──────
const WINDOWS = new Map(); // "chat\0number" → recent message times (seconds)
const DUPLICATES = new Map(); // "chat\0number" → [time, fingerprint][]
const TRACK = new Map(); // number → [time, chat, sender, messageId][] (max 300)
const ACTIVE = new Map(); // numbers being countered right now
const UNPARSEABLE = new Map(); // number → times of events we could not parse
const GROUP_CACHE = new Map(); // chat → [time, info]

export const WINDOW_SECONDS = 10;
export const GROUP_BURST = 7;
export const DM_BURST = 10;
export const TRACK_SECONDS = 180;
export const MUTE_SECONDS = 30 * 60;
export const DEFAULT_THRESHOLD = 60;
export const MAX_SCAN_CHARS = 200_000;

export const RISKY_KINDS = new Set([
  "nativeFlowMessage", "interactiveMessage", "buttonsMessage", "listMessage", "templateMessage",
  "orderMessage", "productMessage", "invoiceMessage", "paymentInviteMessage", "groupInviteMessage",
  "liveLocationMessage", "contactsArrayMessage",
]);

const isInvisible = (c) =>
  (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) ||
  c === 0xfeff || c === 0x180e || c === 0x034f;
const COMBINING = /^[\p{Mn}\p{Me}]$/u;

const now = () => performance.now() / 1000;
const getList = (map, key) => {
  let v = map.get(key);
  if (!v) map.set(key, (v = []));
  return v;
};

/** Python-style round() (halves go to the even neighbour) so scores match the original bot exactly. */
export function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export class Signal {
  constructor(key, label, points, detail = "") {
    this.key = key;
    this.label = label;
    this.points = points;
    this.detail = detail;
  }
}

export class ThreatReport {
  constructor({ strength, signals = [], handled = false, countered = false, outcome = {} }) {
    this.strength = strength;
    this.signals = signals;
    this.handled = handled; // the pipeline must stop processing this message
    this.countered = countered;
    this.outcome = outcome;
  }

  get primary() {
    if (!this.signals.length) return "clean";
    return this.signals.reduce((best, s) => (s.points > best.points ? s : best)).label;
  }

  get level() {
    return levelFor(this.strength);
  }
}

export const levelFor = (s) => (s < 30 ? "LOW" : s < 60 ? "MEDIUM" : s < 80 ? "HIGH" : "CRITICAL");

export function strengthBar(strength) {
  const filled = Math.max(0, Math.min(10, pyRound(strength / 10)));
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

/** Strongest signal dominates; every extra signal adds 35 % of its weight. Capped at 100. */
export function combine(points) {
  if (!points.length) return 0;
  const ordered = [...points].sort((a, b) => b - a);
  const rest = ordered.slice(1).reduce((a, b) => a + b, 0);
  return Math.min(100, pyRound(ordered[0] + 0.35 * rest));
}

// ── payload analysis ────────────────────────────────────────────────────
function textFingerprint(text) {
  const normalized = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** Static signals from one message. Pure function: no I/O, safe to unit-test. */
export function analyzePayload(text, meta = {}) {
  text = text || "";
  meta = meta || {};
  const out = [];
  const size = Buffer.byteLength(text, "utf8");
  if (size > 20000) out.push(new Signal("oversized", "oversized payload", 90, `${size} bytes`));
  else if (size > 12000) out.push(new Signal("oversized", "oversized payload", 60, `${size} bytes`));

  const scan = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  if (scan) {
    let controls = 0, invisible = 0, combining = 0, total = 0;
    let longestRun = 0, run = 0, prev = null;
    for (const ch of scan) {
      total += 1;
      const code = ch.codePointAt(0);
      if ((code < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t") || code === 0x7f) controls += 1;
      else if (isInvisible(code)) invisible += 1;
      else if (COMBINING.test(ch)) combining += 1;
      run = ch === prev ? run + 1 : 1;
      prev = ch;
      if (run > longestRun) longestRun = run;
    }
    if (controls >= 200) out.push(new Signal("controls", "control-character flood", 85, `${controls} control chars`));
    else if (controls >= 20) out.push(new Signal("controls", "control-character flood", 55, `${controls} control chars`));
    if (invisible >= 300) out.push(new Signal("invisible", "invisible-character flood", 85, `${invisible} invisible/bidi chars`));
    else if (invisible >= 30) out.push(new Signal("invisible", "invisible-character flood", 55, `${invisible} invisible/bidi chars`));
    if (combining >= 400) out.push(new Signal("combining", "combining-mark overload", 85, `${combining} combining marks`));
    else if (combining >= 80 && combining / Math.max(1, total) >= 0.5) {
      out.push(new Signal("combining", "combining-mark overload", 70, `${combining} combining marks`));
    }
    if (longestRun >= 3000) out.push(new Signal("charrun", "repeated-character payload", 60, `${longestRun}× same character`));
    const longestToken = scan.split(/\s+/).reduce((m, t) => Math.max(m, t.length), 0);
    if (longestToken >= 4000 && longestRun < 3000) out.push(new Signal("token", "unbroken giant token", 50, `${longestToken} chars without spaces`));
    const urls = (scan.match(/https?:\/\//gi) || []).length;
    if (urls >= 8) out.push(new Signal("urls", "link flood", 60, `${urls} links`));
    const mentions = (scan.match(/@\d{7,15}/g) || []).length;
    if (mentions >= 12) out.push(new Signal("mentions-text", "mass-mention payload", 60, `${mentions} @mentions`));
  }

  const mentioned = Number(meta.mentions || 0);
  if (mentioned >= 1000) out.push(new Signal("mentions-meta", "mass-mention payload", 85, `${mentioned} mentioned JIDs`));
  else if (mentioned >= 200) out.push(new Signal("mentions-meta", "mass-mention payload", 60, `${mentioned} mentioned JIDs`));
  const proto = Number(meta.protoSize || 0);
  if (proto > 262_144) out.push(new Signal("proto", "oversized message structure", 85, `${proto} bytes on the wire`));
  else if (proto > 65_536) out.push(new Signal("proto", "oversized message structure", 50, `${proto} bytes on the wire`));
  if (Number(meta.vcardLen || 0) > 20_000) out.push(new Signal("vcard", "oversized contact card", 60, `${meta.vcardLen} chars`));
  if (meta.unparseable) out.push(new Signal("unparseable", "unparseable payload", 45, String(meta.error || "").slice(0, 80)));
  if (RISKY_KINDS.has(meta.kind)) out.push(new Signal("kind", "interactive/structured message", 20, String(meta.kind)));
  return out;
}

// ── group helpers ───────────────────────────────────────────────────────
async function groupInfo(session, chat) {
  const t = now();
  const cached = GROUP_CACHE.get(chat);
  if (cached && t - cached[0] < 30) return cached[1];
  try {
    const info = await session.groupInfo(chat);
    GROUP_CACHE.set(chat, [t, info]);
    return info;
  } catch {
    return null;
  }
}

async function groupAdmin(session, chat, senderNumber) {
  const info = await groupInfo(session, chat);
  if (info === null) return false;
  const p = findParticipant(info, senderNumber);
  return Boolean(p && isAdmin(p));
}

async function botAdmin(session, chat) {
  const info = await groupInfo(session, chat);
  if (info === null) return false;
  const p = findParticipant(info, session.number);
  return Boolean(p && isAdmin(p));
}

const isGroup = (chat) => String(chat).endsWith("@g.us");

function exempt(session, number) {
  const cfg = config.get();
  return Boolean(cfg.owner.numbers.includes(number) || number === session.number || db.isSudo(number) || db.antibugTrusted(number));
}

// ── counter actions ─────────────────────────────────────────────────────
async function tryBlock(session, msg) {
  if (typeof session.blockContact !== "function") return ["unsupported", "this session cannot block contacts"];
  try {
    await session.blockContact(msg.sender);
    return ["ok", ""];
  } catch (exc) {
    if (exc instanceof NotImplementedError) return ["unsupported", String(exc.message).slice(0, 120)];
    return ["failed", String(exc.message ?? exc).slice(0, 120)];
  }
}

/** Delete every tracked message. Returns [purged, targets, note]. */
async function purge(session, refs, canModerate) {
  const targets = refs.length;
  const notes = new Set();
  let inFlight = 0;
  const waiters = [];
  const acquire = async () => {
    if (inFlight >= 8) await new Promise((r) => waiters.push(r));
    inFlight += 1;
  };
  const release = () => {
    inFlight -= 1;
    waiters.shift()?.();
  };

  const one = async ([chat, senderJid, messageId]) => {
    if (!messageId) {
      notes.add("message id unavailable");
      return false;
    }
    await acquire();
    try {
      if (isGroup(chat)) {
        if (!canModerate) {
          notes.add("bot is not a group admin");
          return false;
        }
        await session.deleteMessage(chat, senderJid, messageId);
      } else {
        if (typeof session.deleteForMe !== "function") {
          notes.add("delete-for-me unsupported");
          return false;
        }
        await session.deleteForMe(chat, senderJid, messageId);
      }
      return true;
    } catch (exc) {
      if (exc instanceof NotImplementedError) {
        notes.add("delete unsupported by this WhatsApp library");
        return false;
      }
      logger.warn(`antibug purge failed: ${exc.message ?? exc}`);
      notes.add("delete rejected by WhatsApp");
      return false;
    } finally {
      release();
    }
  };

  const results = await Promise.all(refs.map(one));
  let purged = results.filter(Boolean).length;

  // DM fallback: wipe the whole attacker chat if per-message deletion was not possible.
  const dmChats = new Set(refs.filter(([c]) => !isGroup(c)).map(([c]) => c));
  if (purged < targets && dmChats.size && typeof session.deleteChat === "function") {
    let wiped = 0;
    for (const chat of dmChats) {
      try {
        await session.deleteChat(chat);
        wiped += refs.filter(([c]) => c === chat).length;
      } catch (exc) {
        logger.warn(`antibug chat wipe failed: ${exc.message ?? exc}`);
      }
    }
    if (wiped) {
      purged = Math.min(targets, Math.max(purged, wiped));
      notes.delete("delete-for-me unsupported");
    }
  }
  return [purged, targets, [...notes].sort().join(", ")];
}

/**
 * Percent of the counter that is *confirmed*: block 50 · purge 30 · shield 20.
 * Components the owner switched off are left out; failed/unsupported ones score zero.
 */
export function effectiveness(block, purged, targets, shield, settings) {
  let weight = 0, earned = 0;
  if (settings.autoblock ?? true) {
    weight += 50;
    earned += block === "ok" ? 50 : 0;
  }
  if (settings.autopurge ?? true) {
    weight += 30;
    earned += targets ? 30 * (purged / targets) : 30;
  }
  weight += 20;
  earned += shield ? 20 : 0;
  return weight ? pyRound((100 * earned) / weight) : 0;
}

function blockText(status, why) {
  return {
    ok: "✅ blocked on WhatsApp",
    failed: `❌ block failed (${why})`,
    unsupported: `➖ not supported here (${why})`,
    skipped: "⏸ auto-block is OFF",
  }[status];
}

export function formatReport(msg, report, where) {
  const o = report.outcome;
  const detected =
    [...report.signals].sort((a, b) => b.points - a.points).slice(0, 5)
      .map((s) => `  • ${s.label}${s.detail ? ` — ${s.detail}` : ""}`).join("\n") || "  • behaviour pattern";
  let purgeLine = `${o.purged ?? 0}/${o.targets ?? 0} messages deleted`;
  if (o.purge_note) purgeLine += ` (${o.purge_note})`;
  return (
    "🛡 ANTIBUG — THREAT COUNTERED\n\n" +
    `Attacker: +${msg.senderNumber}\n` +
    `Name: ${msg.pushName || "Unavailable"}\n` +
    `Where: ${where}\n\n` +
    `Bug strength: ${report.strength}/100 ${strengthBar(report.strength)} ${report.level}\n` +
    `Detected:\n${detected}\n\n` +
    "Counter actions:\n" +
    `  • ${blockText(o.block ?? "skipped", o.block_note ?? "")}\n` +
    `  • ${purgeLine}\n` +
    "  • ✅ bot shield active (all further messages dropped)\n\n" +
    `Counter effectiveness: ${o.effectiveness ?? 0}%\n` +
    "(calculated from confirmed actions only: block 50 · purge 30 · shield 20)"
  );
}

async function notifyOwners(session, msg, report, group) {
  const text = formatReport(msg, report, group ? "group chat" : "private chat");
  const targets = [...new Set(config.get().owner.numbers.map((n) => `${n}@s.whatsapp.net`))];
  if (group) targets.push(msg.chat);
  for (const chat of targets) {
    if (chat === msg.chat && !group) continue; // never message the (now blocked) attacker
    try {
      await session.sendText(chat, text);
    } catch (exc) {
      logger.warn(`antibug alert send failed: ${exc.message ?? exc}`);
    }
  }
}

// ── main entry ──────────────────────────────────────────────────────────
/** Scan one inbound message. Returns a ThreatReport when the pipeline must stop, else null. */
export async function inspectMessage(session, msg) {
  const number = msg.senderNumber;
  const chat = String(msg.chat);
  const group = isGroup(chat);
  const settings = db.antibugSettings();
  const text = msg.text || "";
  const meta = msg.meta || {};

  // Compatibility: oversized payloads have always been logged, even when protection is paused.
  if (!number) {
    if (Buffer.byteLength(text, "utf8") > 20000) db.logBug({ sender: msg.sender, number, from: chat, reason: "oversized payload" });
    return null;
  }
  if (!settings.enabled) return null;
  const isExempt = exempt(session, number);

  // 1) shield: already-countered attackers are dropped before anything else runs
  if (!isExempt && (db.antibugShieldGet(number) || ACTIVE.has(number))) {
    if (group && typeof session.deleteMessage === "function") {
      try { await session.deleteMessage(chat, msg.sender, msg.messageId); } catch { /* best effort */ }
    } else if (!group && msg.messageId && typeof session.deleteForMe === "function") {
      try { await session.deleteForMe(chat, msg.sender, msg.messageId); } catch { /* best effort */ }
    }
    return new ThreatReport({ strength: 100, handled: true });
  }

  // 2) soft mute from earlier group incidents
  if (group && !isExempt && db.getMute(chat, number)) {
    try {
      await session.deleteMessage(chat, msg.sender, msg.messageId);
    } catch (exc) {
      logger.warn(`antibug muted-message delete failed: ${exc.message ?? exc}`);
    }
    return new ThreatReport({ strength: 100, handled: true });
  }

  // 3) analyse
  const t = now();
  const key = `${chat}\u0000${number}`;
  const window = getList(WINDOWS, key);
  window.push(t);
  while (window.length && t - window[0] > WINDOW_SECONDS) window.shift();
  const fingerprint = textFingerprint(text);
  const duplicates = getList(DUPLICATES, key);
  duplicates.push([t, fingerprint]);
  while (duplicates.length && t - duplicates[0][0] > 15) duplicates.shift();
  const track = getList(TRACK, number);
  track.push([t, chat, msg.sender, msg.messageId]);
  while (track.length > 300) track.shift();
  while (track.length && t - track[0][0] > TRACK_SECONDS) track.shift();

  const signals = analyzePayload(text, meta);
  const limit = group ? GROUP_BURST : DM_BURST;
  if (window.length >= limit) {
    signals.push(new Signal("burst", "message flood", Math.min(90, 60 + 4 * (window.length - limit)), `${window.length} msgs / ${WINDOW_SECONDS}s`));
  }
  const dup = fingerprint ? duplicates.filter(([, fp]) => fp === fingerprint).length : 0;
  if (dup >= limit) {
    signals.push(new Signal("repeat", "repeated message", Math.min(90, 60 + 4 * (dup - limit)), `${dup} identical`));
  }
  if (meta.unparseable) {
    const strikes = getList(UNPARSEABLE, number);
    strikes.push(t);
    while (strikes.length && t - strikes[0] > 60) strikes.shift();
    if (strikes.length >= 2) signals.push(new Signal("unparseable-repeat", "repeated unparseable payloads", 70, `${strikes.length} in 60s`));
  }
  const report = new ThreatReport({ strength: combine(signals.map((s) => s.points)), signals });
  const threshold = Math.max(20, Math.min(95, Number(settings.threshold) || DEFAULT_THRESHOLD));
  if (report.strength < threshold) return null;

  const baseLog = {
    sender: msg.sender, number, from: chat, reason: report.primary, strength: report.strength,
    signals: report.signals.map((s) => s.label),
  };

  // Claim the sender before any await so a burst of concurrent messages triggers exactly one counter.
  if (ACTIVE.has(number)) return new ThreatReport({ strength: report.strength, handled: true });
  ACTIVE.set(number, t);
  try {
    // 4) exempt senders are logged but never touched
    if (isExempt || (group && (await groupAdmin(session, chat, number)))) {
      db.logBug({ ...baseLog, action: "exempt" });
      window.length = 0;
      duplicates.length = 0;
      return null;
    }

    // 5) counter: block + purge run together for speed
    const canModerate = group && (await botAdmin(session, chat));
    const refs = track.map(([, c, s, m]) => [c, s, m]);
    const [blockRes, purgeRes] = await Promise.all([
      settings.autoblock ? tryBlock(session, msg) : ["skipped", ""],
      settings.autopurge ? purge(session, refs, canModerate) : [0, refs.length, "auto-purge is OFF"],
    ]);
    const [block, blockNote] = blockRes;
    const [purged, targets, purgeNote] = purgeRes;
    db.antibugShieldAdd(number, report.strength, report.primary, block === "ok");
    if (group && canModerate && purged > 0) db.setMuted(chat, number, db.nowMs() + MUTE_SECONDS * 1000, "antibug flood guard");
    const eff = effectiveness(block, purged, targets, true, settings);
    report.outcome = { block, block_note: blockNote, purged, targets, purge_note: purgeNote, effectiveness: eff };
    report.countered = report.handled = true;
    db.logBug({ ...baseLog, action: "countered", blocked: block === "ok", deleted: purged, targets, effectiveness: eff });
    window.length = 0;
    duplicates.length = 0;
    track.length = 0;
    await notifyOwners(session, msg, report, group);
    return report;
  } finally {
    ACTIVE.delete(number);
  }
}

export function resetRuntimeState() {
  WINDOWS.clear();
  DUPLICATES.clear();
  TRACK.clear();
  ACTIVE.clear();
  UNPARSEABLE.clear();
  GROUP_CACHE.clear();
}
