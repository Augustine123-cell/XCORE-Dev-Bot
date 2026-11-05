/**
 * JSON-file database (data/db.json).
 *
 * The on-disk schema (camelCase keys, millisecond timestamps, snake_case telegram_* keys) is identical to the
 * Python and the original Node versions, so an existing db.json can be dropped straight into DATA_DIR.
 *
 * Node is single-threaded and every function here is synchronous, so no locking is needed.
 */
import fs from "node:fs";
import path from "node:path";
import * as config from "./config.js";
import * as logger from "./logger.js";
import { ValueError } from "./errors.js";

export const MODES = ["self", "public", "dev", "maintenance", "stealth"];
export const DAY_MS = 86_400_000;

let cache = null;

export const nowMs = () => Date.now();
export const clean = (n) => String(n ?? "").replace(/\D/g, "");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const toInt = (v, def = 0) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : def;
};

function readJson(file) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isObj(d)) throw new ValueError("db root is not a JSON object");
  return d;
}

/** db.json exists but is unreadable: keep the bad file for inspection, fall back to the last good backup. */
function recover(file, err) {
  const quarantine = path.join(path.dirname(file), `${path.basename(file)}.corrupt-${nowMs()}`);
  try {
    fs.renameSync(file, quarantine);
    logger.error(`${path.basename(file)} unreadable (${err.message}); moved to ${path.basename(quarantine)}`);
  } catch {
    logger.error(`${path.basename(file)} unreadable (${err.message})`);
  }
  try {
    const d = readJson(`${file}.bak`);
    logger.warn(`Restored ${path.basename(file)} from ${path.basename(file)}.bak`);
    return d;
  } catch {
    return {};
  }
}

export function load() {
  if (cache !== null) return cache;
  const file = config.get().paths.dbFile;
  let d;
  try {
    d = readJson(file);
  } catch (e) {
    d = e.code === "ENOENT" ? {} : recover(file, e);
  }
  for (const k of ["sudo", "premium", "banned", "removed", "paired", "buglog", "monitors", "muted", "telegram_payments", "disabled_sessions"]) {
    if (!Array.isArray(d[k])) d[k] = [];
  }
  for (const k of ["names", "telegram_links", "telegram_pending_premium"]) {
    if (!isObj(d[k])) d[k] = {};
  }
  if (!isObj(d.ai)) d.ai = {};
  if (!isObj(d.ai_modes)) d.ai_modes = {};
  const ab = isObj(d.antibug) ? d.antibug : {};
  d.antibug = {
    enabled: ab.enabled === undefined ? true : Boolean(ab.enabled),
    autoblock: ab.autoblock === undefined ? true : Boolean(ab.autoblock),
    autopurge: ab.autopurge === undefined ? true : Boolean(ab.autopurge),
    threshold: toInt(ab.threshold) || 60,
    trusted: Array.isArray(ab.trusted) ? ab.trusted.map(clean).filter(Boolean) : [],
    blocked: isObj(ab.blocked) ? ab.blocked : {},
  };
  if (d.mode === undefined || d.mode === null) d.mode = config.get().bot.mode;
  if (d.antiban === undefined || d.antiban === null) d.antiban = true;
  const st = isObj(d.stats) ? d.stats : {};
  d.stats = { checks: toInt(st.checks), banned: toInt(st.banned), safe: toInt(st.safe) };
  if (d.startedAt === undefined || d.startedAt === null) d.startedAt = nowMs();
  cache = d;
  return d;
}

export function save() {
  const d = load();
  const file = config.get().paths.dbFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(d, null, 2));
    fs.fsyncSync(fd); // reach the disk before we swap it in (a redeploy can kill us any moment)
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`); // last known-good copy
    } catch {
      /* best effort */
    }
  }
  fs.renameSync(tmp, file); // atomic: never leaves a half-written db.json
}

/** Forget the in-memory copy (used by tests). */
export function resetCache() {
  cache = null;
}

// ── sudo ────────────────────────────────────────────────────────────────
export function isSudo(n) {
  const c = clean(n);
  return config.get().owner.numbers.includes(c) || load().sudo.includes(c);
}

export function addSudo(n) {
  const c = clean(n);
  const d = load();
  if (!d.sudo.includes(c)) {
    d.sudo.push(c);
    save();
  }
}

export function removeSudo(n) {
  const c = clean(n);
  const d = load();
  d.sudo = d.sudo.filter((x) => x !== c);
  save();
}

export const listSudo = () => [...load().sudo];

// ── premium ─────────────────────────────────────────────────────────────
export function isPremium(n) {
  const c = clean(n);
  if (isSudo(c)) return true;
  const p = load().premium.find((x) => x.number === c);
  return Boolean(p) && (!p.until || p.until > nowMs());
}

export function addPremium(n, days = 30, plan = "standard", by = "owner") {
  const c = clean(n);
  const d = load();
  d.premium = d.premium.filter((x) => x.number !== c);
  d.premium.push({ number: c, until: days > 0 ? nowMs() + days * DAY_MS : null, plan, addedAt: nowMs(), addedBy: by });
  save();
}

export function removePremium(n) {
  const c = clean(n);
  const d = load();
  d.premium = d.premium.filter((x) => x.number !== c);
  save();
}

export function listPremium() {
  return load().premium.map((p) => ({
    ...p,
    expired: Boolean(p.until && p.until < nowMs()),
    daysLeft: p.until ? Math.max(0, Math.floor((p.until - nowMs()) / DAY_MS)) : "∞",
  }));
}

const remainingDays = (until) => Math.max(0, Math.floor((Number(until) - nowMs() + DAY_MS - 1) / DAY_MS));

export function linkTelegramUser(userId, number) {
  const d = load();
  const uid = String(toInt(userId));
  const phone = clean(number);
  d.telegram_links[uid] = phone;
  const pending = d.telegram_pending_premium[uid];
  if (pending && toInt(pending.until) > nowMs()) {
    addPremium(phone, Math.max(1, remainingDays(pending.until)), "telegram-stars", uid);
    delete d.telegram_pending_premium[uid];
  }
  save();
}

export function telegramLinkedNumber(userId) {
  return load().telegram_links?.[String(toInt(userId))] ?? null;
}

export function grantTelegramPremium(userId, days, by = "telegram-stars") {
  days = toInt(days);
  if (!(days >= 1 && days <= 3650)) throw new ValueError("Premium duration must be between 1 and 3650 days");
  const uid = String(toInt(userId));
  const phone = telegramLinkedNumber(userId);
  if (phone) {
    const current = load().premium.find((p) => p.number === phone);
    if (current && !current.until) return phone; // permanent Premium is not downgraded by a subscription purchase
    const remaining = current && current.until ? remainingDays(current.until) : 0;
    addPremium(phone, Math.min(3650, days + remaining), "telegram-stars", by);
    return phone;
  }
  const d = load();
  const existing = d.telegram_pending_premium[uid] || {};
  const base = Math.max(nowMs(), toInt(existing.until));
  d.telegram_pending_premium[uid] = { until: base + days * DAY_MS, days, by };
  save();
  return null;
}

/** Idempotently apply a successful Telegram Stars payment once per charge ID → [applied, phone]. */
export function applyTelegramPayment(paymentId, userId, days) {
  const charge = String(paymentId ?? "").trim();
  if (!charge) throw new ValueError("Missing Telegram payment charge ID");
  const d = load();
  if (d.telegram_payments.some((x) => x.charge_id === charge)) return [false, telegramLinkedNumber(userId)];
  d.telegram_payments.push({ charge_id: charge, user_id: String(toInt(userId)), days: toInt(days), at: nowMs() });
  d.telegram_payments = d.telegram_payments.slice(-1000);
  save();
  const phone = grantTelegramPremium(userId, days, "telegram-stars");
  return [true, phone];
}

export function revokeTelegramPremium(userId) {
  const uid = String(toInt(userId));
  const phone = telegramLinkedNumber(userId);
  if (phone) removePremium(phone);
  const d = load();
  delete d.telegram_pending_premium[uid];
  save();
}

// ── local bans ──────────────────────────────────────────────────────────
export function isBanned(n) {
  const c = clean(n);
  const d = load();
  const b = d.banned.find((x) => x.number === c);
  if (!b) return false;
  if (b.until && b.until < nowMs()) {
    d.banned = d.banned.filter((x) => x.number !== c); // temp ban expired
    save();
    return false;
  }
  return true;
}

export function banUser(n, days = 0, reason = "No reason", by = "owner") {
  const c = clean(n);
  const d = load();
  d.banned = d.banned.filter((x) => x.number !== c);
  d.banned.push({ number: c, until: days > 0 ? nowMs() + days * DAY_MS : null, reason, bannedAt: nowMs(), bannedBy: by });
  save();
}

export function unbanUser(n) {
  const c = clean(n);
  const d = load();
  d.banned = d.banned.filter((x) => x.number !== c);
  save();
}

export const listBanned = () =>
  load().banned.map((b) => ({
    ...b,
    daysLeft: b.until ? Math.max(0, Math.floor((b.until - nowMs()) / DAY_MS)) : "permanent",
  }));

// ── removed users ───────────────────────────────────────────────────────
export const isRemoved = (n) => load().removed.includes(clean(n));

export function removeUser(n) {
  const c = clean(n);
  const d = load();
  d.sudo = d.sudo.filter((x) => x !== c);
  d.premium = d.premium.filter((x) => x.number !== c);
  d.paired = d.paired.filter((x) => x !== c);
  if (!d.removed.includes(c)) d.removed.push(c);
  save();
}

export function restoreUser(n) {
  const c = clean(n);
  const d = load();
  d.removed = d.removed.filter((x) => x !== c);
  save();
}

export const listRemoved = () => [...load().removed];

// ── paired numbers ──────────────────────────────────────────────────────
export const isPaired = (n) => load().paired.includes(clean(n));

export function addPaired(n) {
  const c = clean(n);
  const d = load();
  if (!d.paired.includes(c)) {
    d.paired.push(c);
    save();
  }
}

export const listPaired = () => [...load().paired];

export function removePaired(n) {
  const c = clean(n);
  const d = load();
  d.paired = d.paired.filter((x) => clean(x) !== c);
  save();
}

export function setSessionDisabled(n, disabled = true) {
  const c = clean(n);
  const d = load();
  d.disabled_sessions = d.disabled_sessions.filter((x) => clean(x) !== c);
  if (disabled) d.disabled_sessions.push(c);
  save();
}

export const isSessionDisabled = (n) => load().disabled_sessions.map(clean).includes(clean(n));

export const listTelegramLinks = () =>
  Object.entries(load().telegram_links).map(([uid, phone]) => ({ telegram_id: Number(uid), number: phone }));

export function unlinkTelegramNumber(number) {
  const phone = clean(number);
  const d = load();
  d.telegram_links = Object.fromEntries(Object.entries(d.telegram_links).filter(([, linked]) => clean(linked) !== phone));
  save();
}

/** Link a Telegram identity to a WhatsApp number and grant Premium to that number. */
export function grantPremiumIdentity(userId, number, days, by = "owner-dashboard") {
  const uid = String(toInt(userId));
  const phone = clean(number);
  const duration = toInt(days);
  if (phone.length < 7 || phone.length > 15) throw new ValueError("WhatsApp number must contain 7–15 digits with country code");
  if (!(duration >= 1 && duration <= 3650)) throw new ValueError("Premium duration must be between 1 and 3650 days");
  const d = load();
  d.telegram_links[uid] = phone;
  save();
  const current = load().premium.find((x) => x.number === phone);
  const remaining = current && current.until ? remainingDays(current.until) : 0;
  addPremium(phone, Math.min(3650, duration + remaining), "owner-grant", by);
}

// ── mode / antiban / stats / bug log ────────────────────────────────────
export const getMode = () => load().mode;

export function setMode(m) {
  if (!MODES.includes(m)) throw new ValueError(`Invalid mode: ${m}`);
  load().mode = m;
  save();
}

export const getAntiban = () => Boolean(load().antiban);

export function setAntiban(v) {
  load().antiban = Boolean(v);
  save();
}

export function bumpStats(banned) {
  const s = load().stats;
  s.checks += 1;
  if (banned === true) s.banned += 1;
  else if (banned === false) s.safe += 1;
  save();
}

export const getStats = () => ({ ...load().stats });
export const getStartedAt = () => load().startedAt;

export function logBug(entry) {
  const d = load();
  d.buglog.unshift({ ...entry, at: nowMs() });
  d.buglog = d.buglog.slice(0, 200);
  save();
}

export const listBugs = (n = 20) => load().buglog.slice(0, n);

const muteKey = (chat, number) => `${String(chat)}\u0000${clean(number)}`;
const sameMute = (x, chat, number) => muteKey(x.chat, x.number) === muteKey(chat, number);

export function setMuted(chat, number, untilMs, reason = "antibug") {
  const d = load();
  d.muted = d.muted.filter((x) => !sameMute(x, chat, number));
  d.muted.push({ chat: String(chat), number: clean(number), until: toInt(untilMs), reason });
  save();
}

export function getMute(chat, number) {
  const d = load();
  const item = d.muted.find((x) => sameMute(x, chat, number));
  if (!item) return null;
  if (toInt(item.until) <= nowMs()) {
    d.muted = d.muted.filter((x) => x !== item);
    save();
    return null;
  }
  return { ...item };
}

export function clearMute(chat, number) {
  const d = load();
  d.muted = d.muted.filter((x) => !sameMute(x, chat, number));
  save();
}

// ── XCORE AI settings ───────────────────────────────────────────────────
export function getAIProvider() {
  const p = String(load().ai?.provider || config.get().ai.provider).toLowerCase();
  return p === "gemini" ? "gemini" : "openai";
}

export function setAIProvider(provider) {
  const p = String(provider || "").toLowerCase();
  if (![["openai", "gemini"].includes(p)]) throw new ValueError("AI provider must be openai or gemini");
  load().ai = { ...(load().ai || {}), provider: p };
  save();
}

export function getAIMode(chat) {
  return Boolean(load().ai_modes?.[String(chat)]);
}

export function setAIMode(chat, enabled) {
  const d = load();
  d.ai_modes = isObj(d.ai_modes) ? d.ai_modes : {};
  d.ai_modes[String(chat)] = Boolean(enabled);
  save();
}

export function listAIModes() {
  const d = load();
  return Object.entries(d.ai_modes || {}).map(([chat, enabled]) => ({ chat, enabled: Boolean(enabled) }));
}

export function clearAIMode(chat) {
  const d = load();
  if (d.ai_modes) delete d.ai_modes[String(chat)];
  save();
}

// ── antibug settings, trust list and attacker shield ────────────────────
export function antibugSettings() {
  const a = load().antibug;
  return Object.fromEntries(
    Object.entries(a).map(([k, v]) => [k, Array.isArray(v) ? [...v] : isObj(v) ? { ...v } : v]),
  );
}

export function setAntibugOption(key, value) {
  if (!["enabled", "autoblock", "autopurge", "threshold"].includes(key)) throw new ValueError(`Unknown antibug option: ${key}`);
  load().antibug[key] = key === "threshold" ? toInt(value) : Boolean(value);
  save();
}

export const antibugTrusted = (n) => load().antibug.trusted.includes(clean(n));

export function antibugTrust(n, trusted = true) {
  const num = clean(n);
  const a = load().antibug;
  a.trusted = a.trusted.filter((x) => x !== num);
  if (trusted && num) a.trusted.push(num);
  save();
}

/** Remember an attacker so the bot drops everything they send, even if WhatsApp's own block failed. */
export function antibugShieldAdd(n, strength, reason, waBlocked) {
  load().antibug.blocked[clean(n)] = { at: nowMs(), strength: toInt(strength), reason: String(reason), waBlocked: Boolean(waBlocked) };
  save();
}

export function antibugShieldRemove(n) {
  const blocked = load().antibug.blocked;
  const key = clean(n);
  const had = key in blocked;
  delete blocked[key];
  save();
  return had;
}

export function antibugShieldGet(n) {
  const item = load().antibug.blocked[clean(n)];
  return item ? { ...item } : null;
}

export const antibugShieldList = () => ({ ...load().antibug.blocked });

// ── display names (used by the clan scanner) ────────────────────────────
export function saveName(jid, name) {
  const d = load();
  d.names[jid] = { name: String(name), at: nowMs() };
  const keys = Object.keys(d.names);
  if (keys.length > 2000) {
    // prune the 500 oldest
    keys.sort((a, b) => (d.names[a].at || 0) - (d.names[b].at || 0)).slice(0, 500).forEach((k) => delete d.names[k]);
  }
  save();
}

export const getName = (jid) => load().names[jid]?.name ?? null;

// ── monitors ────────────────────────────────────────────────────────────
export function addMonitor(url, chatJid, addedBy) {
  const d = load();
  if (d.monitors.some((m) => m.url === url)) return false;
  d.monitors.push({
    url,
    chatJid,
    addedBy,
    addedAt: nowMs(),
    status: "unknown",
    lastCheck: null,
    lastDown: null,
    downSince: null,
    totalChecks: 0,
    totalDown: 0,
  });
  save();
  return true;
}

export function removeMonitor(url) {
  const d = load();
  d.monitors = d.monitors.filter((m) => m.url !== url);
  save();
}

export const listMonitors = () => load().monitors;

export function updateMonitor(url, patch) {
  const m = load().monitors.find((x) => x.url === url);
  if (!m) return;
  Object.assign(m, patch);
  m.lastCheck = nowMs();
  save();
}

// ── roles ───────────────────────────────────────────────────────────────
export function getRole(n) {
  const c = clean(n);
  if (config.get().owner.numbers.includes(c)) return "OWNER";
  if (isRemoved(c)) return "REMOVED";
  if (isBanned(c)) return "BANNED";
  if (isSudo(c)) return "SUDO";
  if (isPremium(c)) return "PREMIUM";
  if (isPaired(c)) return "PAIRED";
  return "USER";
}
