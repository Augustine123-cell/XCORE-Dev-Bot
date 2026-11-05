/**
 * WhatsApp transport — the ONLY module that touches the WhatsApp library (Baileys).
 *
 * Baileys delivers events on the Node event loop, so every inbound message is normalised into an
 * `Incoming` (see context.js) and handed to the handler; command code never sees Baileys objects.
 * The library is loaded lazily through `baileysLoader`, which keeps this file testable with a fake.
 */
import fs from "node:fs";
import path from "node:path";
import * as config from "../config.js";
import * as db from "../db.js";
import * as logger from "../logger.js";
import { NotImplementedError } from "../errors.js";
import { brandMessage } from "../format.js";
import { makeIncoming, normJid } from "./context.js";
import { handleMessage } from "./handler.js";
import { sessions, listSessions } from "./state.js";
import { numberFromJid } from "./groupUtils.js";

export { sessions, listSessions };

/** Tests replace `load` with a function returning a fake Baileys module. */
export const baileysLoader = {
  async load() {
    const mod = await import("@whiskeysockets/baileys");
    const makeWASocket = mod.default?.default ?? mod.default ?? mod.makeWASocket;
    return { ...mod, makeWASocket };
  },
};

/** Timing knobs (tests shrink them). */
export const tuning = {
  connectWaitMs: 6000, // wait for an existing session to come online before requesting a pairing code
  pairSettleMs: 1500, // let a fresh socket finish its handshake before the first pairing request
  pairAttempts: 8,
  pairRetryDelayMs: 2000,
  reconnectBaseMs: 2000,
  reconnectMaxMs: 30000,
};

const digits = (s) => String(s ?? "").replace(/\D/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKIP_KINDS = new Set(["messageContextInfo", "senderKeyDistributionMessage", "deviceSentMessage"]);
const WRAPPERS = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension", "documentWithCaptionMessage", "editedMessage"];
const CONTEXT_HOLDERS = ["extendedTextMessage", "imageMessage", "videoMessage", "documentMessage", "audioMessage", "stickerMessage", "buttonsMessage", "listMessage", "templateMessage"];

/** Strip ephemeral / view-once / caption wrappers to reach the real content. */
function unwrap(message) {
  let cur = message;
  for (let i = 0; i < 5 && cur; i += 1) {
    const w = WRAPPERS.find((k) => cur[k]?.message);
    if (!w) break;
    cur = cur[w].message;
  }
  return cur;
}

function contextInfoOf(content) {
  for (const k of CONTEXT_HOLDERS) if (content?.[k]?.contextInfo) return content[k].contextInfo;
  return null;
}

/** Cheap payload statistics for the anti-bug engine. Never throws. */
export function payloadMeta(m, byteSize = null) {
  const meta = {};
  try {
    if (byteSize) meta.protoSize = Number(byteSize(m)) || 0;
  } catch { /* optional */ }
  try {
    const kinds = Object.keys(m.message || {}).filter((k) => !SKIP_KINDS.has(k) && m.message[k] != null);
    if (kinds.length) meta.kind = kinds[0];
  } catch { /* optional */ }
  try {
    const content = unwrap(m.message);
    let mentions = 0;
    for (const k of CONTEXT_HOLDERS) mentions = Math.max(mentions, (content?.[k]?.contextInfo?.mentionedJid ?? []).length);
    meta.mentions = mentions;
    const vcard = content?.contactMessage?.vcard || "";
    const arr = content?.contactsArrayMessage?.contacts || [];
    meta.vcardLen = vcard.length + arr.reduce((a, c) => a + (c?.vcard || "").length, 0);
  } catch { /* optional */ }
  return meta;
}

function senderOf(key, selfNumber, altSender) {
  const chat = key.remoteJid;
  const group = chat.endsWith("@g.us");
  if (key.fromMe) return `${selfNumber}@s.whatsapp.net`; // our own account (the paired phone / linked device)
  let sender = group ? key.participant : chat;
  // WhatsApp may identify senders by an anonymous "LID"; prefer the real phone-number JID when given.
  const alt = altSender ?? (group ? key.participantAlt ?? key.participantPn : key.remoteJidAlt ?? key.senderPn);
  if (sender && sender.endsWith("@lid") && alt) sender = alt;
  return sender;
}

/** Last-resort parse for events that break parseMessage: keep only who sent it, flag it unparseable. */
export function parseMinimal(m, error, { selfNumber = "", altSender = null } = {}) {
  try {
    const key = m.key;
    const chat = key.remoteJid;
    const sender = senderOf(key, selfNumber, altSender);
    const number = digits(String(sender).split("@")[0].split(":")[0]);
    if (!chat || !number || chat.endsWith("@broadcast") || chat.endsWith("@newsletter")) return null;
    return makeIncoming({
      chat, sender: normJid(sender), senderNumber: number, text: "", messageId: String(key.id ?? ""), raw: m,
      meta: { unparseable: true, error: `${error?.name ?? "Error"}: ${error?.message ?? error}` },
    });
  } catch {
    return null;
  }
}

/** Convert a Baileys WAMessage into an Incoming (null for things we ignore). */
export function parseMessage(m, { selfNumber = "", altSender = null, byteSize = null } = {}) {
  const key = m?.key;
  if (!key || !key.remoteJid) return null;
  const chat = key.remoteJid;
  if (chat.endsWith("@broadcast") || chat.endsWith("@newsletter")) return null; // status updates / channels
  const sender = senderOf(key, selfNumber, altSender);
  if (!sender) return null;
  const number = digits(String(sender).split("@")[0].split(":")[0]);
  const message = m.message;
  if (!message) return null; // protocol stubs carry no content
  const content = unwrap(message) || {};
  const text = content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || "";
  const quoted = contextInfoOf(content)?.participant || null;
  return makeIncoming({
    chat,
    sender: normJid(sender),
    senderNumber: number,
    text,
    pushName: m.pushName || "",
    quotedParticipant: quoted,
    messageId: String(key.id ?? ""),
    raw: m,
    meta: payloadMeta(m, byteSize),
  });
}

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".pdf": "application/pdf", ".zip": "application/zip",
  ".txt": "text/plain", ".json": "application/json", ".apk": "application/vnd.android.package-archive",
};
const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";

const pending = new Map(); // sessions that were started but are not connected yet
const disabledSessions = new Set();

/** One linked WhatsApp account. It survives socket re-creation (reconnects) so waiters keep working. */
export class WASession {
  constructor(number, lib, folder) {
    this.number = number;
    this.lib = lib;
    this.folder = folder;
    this.sock = null;
    this.state = null;
    this.closed = false;
    this.connected = false;
    this.waiters = [];
    this.keys = new Map(); // message id → key (bounded), needed to delete messages
    this.lastByChat = new Map(); // chat → { key, ts } (bounded), anchors "delete chat"
    this.reconnectDelay = tuning.reconnectBaseMs;
    this.reconnectTimer = null;
    this.opening = false;
  }

  isConnected() { return this.connected; }
  registered() { return Boolean(this.state?.creds?.registered); }

  waitConnected(ms) {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== done); resolve(false); }, ms);
      const done = () => { clearTimeout(t); resolve(true); };
      this.waiters.push(done);
    });
  }

  _setConnected(v) {
    this.connected = v;
    if (v) { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
  }

  async open() {
    if (this.opening || this.closed) return;
    this.opening = true;
    try {
      const lib = this.lib;
      fs.mkdirSync(this.folder, { recursive: true });
      const { state, saveCreds } = await lib.useMultiFileAuthState(this.folder);
      this.state = state;
      let version;
      try { version = (await lib.fetchLatestBaileysVersion?.())?.version; } catch { /* use the library default */ }
      let pino = null;
      try { pino = (await import("pino")).default; } catch { /* optional */ }
      const log = pino ? pino({ level: "silent" }) : silentLogger();
      this.log = log;
      this._detach();
      const sock = lib.makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        logger: log,
        printQRInTerminal: false,
        browser: lib.Browsers?.ubuntu ? lib.Browsers.ubuntu("Chrome") : ["XCORE", "Chrome", "1.0"],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
      });
      this.sock = sock;
      sock.ev.on("creds.update", saveCreds);
      sock.ev.on("connection.update", (u) => this._onConnection(u));
      sock.ev.on("messages.upsert", (u) => this._onUpsert(u));
    } finally {
      this.opening = false;
    }
  }

  _detach() {
    const old = this.sock;
    this.sock = null;
    if (!old) return;
    try { old.ev?.removeAllListeners?.("connection.update"); old.ev?.removeAllListeners?.("messages.upsert"); } catch { /* ignore */ }
    try { old.end?.(undefined); } catch { /* ignore */ }
  }

  _onConnection(u) {
    const { connection, lastDisconnect } = u || {};
    if (connection === "open") {
      if (this.closed || disabledSessions.has(this.number)) { this.disconnect(); return; }
      sessions.set(this.number, this);
      pending.delete(this.number);
      db.addPaired(this.number);
      this.reconnectDelay = tuning.reconnectBaseMs;
      this._setConnected(true);
      logger.ok(`Session open: +${this.number}`);
    } else if (connection === "close") {
      this._setConnected(false);
      if (sessions.get(this.number) === this) sessions.delete(this.number);
      if (this.closed || disabledSessions.has(this.number)) return;
      const code = lastDisconnect?.error?.output?.statusCode;
      const reasons = this.lib.DisconnectReason ?? { loggedOut: 401, connectionReplaced: 440 };
      if (code === reasons.loggedOut) {
        logger.error(`Logged out: +${this.number} — local credentials removed, pair again`);
        this.closed = true;
        pending.delete(this.number);
        try { fs.rmSync(this.folder, { recursive: true, force: true }); } catch { /* ignore */ }
        return;
      }
      if (code === (reasons.connectionReplaced ?? 440)) {
        logger.error(`Session replaced: +${this.number} is open elsewhere (another bot instance?). Not reconnecting.`);
        this.closed = true;
        return;
      }
      logger.warn(`Disconnected: +${this.number} (reconnecting in ${Math.round(this.reconnectDelay / 1000)}s)`);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(tuning.reconnectMaxMs, this.reconnectDelay * 2);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closed) return;
      try { await this.open(); } catch (e) { logger.error(`reconnect +${this.number}:`, e); this._scheduleReconnect(); }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  _onUpsert({ messages, type } = {}) {
    if (type !== "notify") return; // "append" is history sync — never act on old messages
    for (const m of messages || []) this._dispatch(m).catch((e) => logger.error("message handler:", e));
  }

  _remember(m) {
    const key = m.key;
    if (!key?.id) return;
    this.keys.set(key.id, { key, ts: Number(m.messageTimestamp) || Math.floor(Date.now() / 1000) });
    if (this.keys.size > 3000) this.keys.delete(this.keys.keys().next().value);
    if (key.remoteJid) {
      this.lastByChat.set(key.remoteJid, { key, ts: Number(m.messageTimestamp) || Math.floor(Date.now() / 1000) });
      if (this.lastByChat.size > 500) this.lastByChat.delete(this.lastByChat.keys().next().value);
    }
  }

  async _resolveAlt(m) {
    const key = m?.key;
    const lid = key?.fromMe ? null : key?.remoteJid?.endsWith("@g.us") ? key.participant : key?.remoteJid;
    if (!lid || !lid.endsWith("@lid")) return null;
    try {
      const pn = await this.sock?.signalRepository?.lidMapping?.getPNForLID?.(lid);
      return pn ? normJid(pn) : null;
    } catch {
      return null;
    }
  }

  async _dispatch(m) {
    try { this._remember(m); } catch { /* bookkeeping only */ }
    const opts = {
      selfNumber: this.number,
      byteSize: this.lib.proto?.Message?.encode ? (x) => this.lib.proto.Message.encode(x.message).finish().length : null,
    };
    let msg;
    try {
      opts.altSender = await this._resolveAlt(m);
      msg = parseMessage(m, opts);
    } catch (e) {
      logger.error("parseMessage:", e);
      msg = parseMinimal(m, e, opts); // a payload that breaks parsing is itself an anti-bug signal
    }
    if (msg) await handleMessage(this, msg);
  }

  // ── sending ───────────────────────────────────────────────────────────
  _need(name) {
    const fn = this.sock?.[name];
    if (typeof fn !== "function") throw new NotImplementedError(`this Baileys version has no ${name}`);
    return fn.bind(this.sock);
  }

  async sendText(chat, text, quoted = null) {
    const body = { text: brandMessage(text) };
    if (quoted) {
      try {
        await this.sock.sendMessage(chat, body, { quoted });
        return;
      } catch (e) {
        logger.warn(`quoted reply failed, sending plain: ${e.message}`); // fall back to a plain message
      }
    }
    await this.sock.sendMessage(chat, body);
  }

  async groupInfo(chat) { return this._need("groupMetadata")(chat); }

  async groupParticipants(chat, numbers, action) {
    let info = null;
    try { info = await this.groupInfo(chat); } catch { /* fall back to plain JIDs */ }
    const jids = numbers.map((n) => {
      const clean = digits(n);
      const p = (info?.participants || []).find((x) => numberFromJid(x.phoneNumber ?? x.jid ?? x.id) === clean);
      return p?.id ?? `${clean}@s.whatsapp.net`; // in LID groups the participant's own id is what WhatsApp expects
    });
    const res = await this._need("groupParticipantsUpdate")(chat, jids, action);
    const bad = (Array.isArray(res) ? res : []).filter((r) => r?.status && !String(r.status).startsWith("2"));
    if (bad.length) throw new Error(`WhatsApp returned status ${bad[0].status}`);
    return res;
  }

  _keyFor(chat, sender, id) {
    return this.keys.get(id)?.key ?? { remoteJid: chat, id, fromMe: false, ...(String(chat).endsWith("@g.us") ? { participant: sender } : {}) };
  }

  async deleteMessage(chat, sender, messageId) {
    if (!messageId) throw new Error("WhatsApp message ID unavailable; cannot delete this message");
    return this._need("sendMessage")(chat, { delete: this._keyFor(chat, sender, messageId) });
  }

  // ── anti-bug primitives ──────────────────────────────────────────────
  async blockContact(jid) { await this._need("updateBlockStatus")(normJid(jid), "block"); }
  async unblockContact(jid) { await this._need("updateBlockStatus")(normJid(jid), "unblock"); }

  /** Remove one inbound message from this account's chat view (not for the sender). */
  async deleteForMe(chat, sender, messageId) {
    const modify = this._need("chatModify");
    const stored = this.keys.get(messageId);
    await modify(
      { deleteForMe: { deleteMedia: false, key: this._keyFor(chat, sender, messageId), timestamp: stored?.ts ?? Math.floor(Date.now() / 1000) } },
      chat,
    );
  }

  /** Delete a whole chat from this account (used to wipe a blocked attacker's thread). */
  async deleteChat(chat) {
    const modify = this._need("chatModify");
    const last = this.lastByChat.get(chat);
    if (!last) throw new NotImplementedError("no known message to anchor the chat deletion");
    await modify({ delete: true, lastMessages: [{ key: last.key, messageTimestamp: last.ts }] }, chat);
  }

  async sendContact(chat, name, number) {
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;type=VOICE;waid=${number}:+${number}\nEND:VCARD`;
    return this.sock.sendMessage(chat, { contacts: { displayName: name, contacts: [{ vcard }] } });
  }

  async sendImage(chat, file, caption = "") {
    return this.sock.sendMessage(chat, { image: fs.readFileSync(file), caption });
  }

  async sendAudio(chat, file, caption = "") {
    await this.sock.sendMessage(chat, { audio: fs.readFileSync(file), mimetype: "audio/mpeg", ptt: false });
    if (caption) await this.sock.sendMessage(chat, { text: caption }); // WhatsApp audio has no caption field
  }

  async sendFile(chat, file, caption = "") {
    return this.sock.sendMessage(chat, { document: fs.readFileSync(file), fileName: path.basename(file), mimetype: mimeOf(file), caption });
  }

  /** Download media from a replied-to or captioned WhatsApp image. */
  async downloadMedia(raw) {
    const quotedCtx = contextInfoOf(unwrap(raw?.message));
    let target = raw;
    if (quotedCtx?.quotedMessage) {
      target = { key: { remoteJid: raw.key.remoteJid, id: quotedCtx.stanzaId, participant: quotedCtx.participant, fromMe: false }, message: quotedCtx.quotedMessage };
    }
    if (typeof this.lib.downloadMediaMessage !== "function") throw new Error("Baileys downloadMediaMessage is unavailable");
    return this.lib.downloadMediaMessage(target, "buffer", {}, { logger: this.log, reuploadRequest: this.sock?.updateMediaMessage });
  }

  async userDevices(number) {
    const fn = this.sock?.getUSyncDevices;
    if (typeof fn !== "function") throw new Error("This Baileys version does not expose device lookup");
    return fn.call(this.sock, [`${digits(number)}@s.whatsapp.net`], false, false);
  }

  async isOnWhatsapp(number) {
    return this._need("onWhatsApp")(`${digits(number)}@s.whatsapp.net`);
  }

  disconnect() {
    this.closed = true;
    this._setConnected(false);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.sock?.end?.(undefined); } catch { /* ignore */ }
    try { this.sock?.ws?.close?.(); } catch { /* ignore */ }
  }
}

function silentLogger() {
  const l = { level: "silent", trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => l };
  return l;
}

/** Disconnect one account and remove this bot's local linked-device credentials. */
export function disconnectSession(number) {
  const clean = digits(number);
  const sess = sessions.get(clean) ?? pending.get(clean);
  sessions.delete(clean);
  pending.delete(clean);
  const folder = path.join(config.get().paths.sessions, clean);
  if (!sess && !fs.existsSync(folder)) return false;
  disabledSessions.add(clean);
  db.setSessionDisabled(clean, true);
  sess?.disconnect();
  // Remove only this account's local credentials; this does not revoke other linked devices from the WhatsApp app.
  try {
    fs.rmSync(folder, { recursive: true, force: true });
  } catch (exc) {
    logger.error(`Could not remove local session for +${clean}:`, exc);
    return false;
  }
  db.removePaired(clean);
  db.unlinkTelegramNumber(clean);
  return true;
}

export const getSession = (number) => sessions.get(digits(number));

/**
 * Start (or resume) a WhatsApp session → { session, pairingCode, error }.
 * If the account is not linked yet, a pairing code is requested (enter it in
 * WhatsApp → Linked devices → Link with phone number).
 */
export async function createSession(number, { requestPairing = false } = {}) {
  const clean = digits(number);
  disabledSessions.delete(clean);
  db.setSessionDisabled(clean, false);
  const existing = sessions.get(clean);
  if (existing && existing.isConnected()) return { session: existing, pairingCode: null, error: null };
  if (!clean || clean.length < 7 || clean.length > 15) return { session: null, pairingCode: null, error: "invalid phone number" };

  let lib;
  try {
    lib = await baileysLoader.load();
  } catch (e) {
    return { session: null, pairingCode: null, error: `WhatsApp library missing (${e.message}). Run: npm install` };
  }
  pending.get(clean)?.disconnect(); // never keep two sockets for one account
  const folder = path.join(config.get().paths.sessions, clean);
  const sess = new WASession(clean, lib, folder);
  pending.set(clean, sess);
  try {
    await sess.open();
  } catch (e) {
    pending.delete(clean);
    return { session: null, pairingCode: null, error: e.message };
  }

  const result = { session: sess, pairingCode: null, error: null };
  if (!requestPairing) return result;

  // Already-linked sessions connect within a few seconds; otherwise ask for a pairing code.
  if (sess.registered()) {
    if (await sess.waitConnected(tuning.connectWaitMs)) return result;
  } else {
    await sleep(tuning.pairSettleMs);
  }
  let lastErr = "no response from WhatsApp";
  for (let i = 0; i < tuning.pairAttempts; i += 1) {
    if (sess.isConnected()) return result; // linked after all
    try {
      const code = String(await sess._need("requestPairingCode")(clean));
      result.pairingCode = code.length === 8 && !code.includes("-") ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
      return result;
    } catch (e) {
      lastErr = e.message || String(e);
      await sleep(tuning.pairRetryDelayMs);
    }
  }
  sess.disconnect();
  pending.delete(clean);
  result.session = null;
  result.error = lastErr;
  return result;
}

export function disconnectAll() {
  for (const s of [...sessions.values(), ...pending.values()]) s.disconnect();
  sessions.clear();
  pending.clear();
}
