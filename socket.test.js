/** whatsapp/socket.js against a fake Baileys module that mimics the API shape the adapter targets. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as config from "../src/config.js";
import * as db from "../src/db.js";
import * as wa from "../src/whatsapp/socket.js";
import { OWNER, isolate, waitFor } from "./helpers.js";

const state = isolate();
const ATTACKER = "2349011112222";
const saved = { ...wa.tuning };

function fakeBaileys({ registered = true, autoOpen = true, pairFailures = 0, pairAlways = false } = {}) {
  const instances = [];
  let pairCalls = 0;
  const lib = {
    instances,
    DisconnectReason: { loggedOut: 401, connectionReplaced: 440, restartRequired: 515 },
    useMultiFileAuthState: async (folder) => {
      fs.mkdirSync(folder, { recursive: true });
      return { state: { creds: { registered } }, saveCreds: async () => {} };
    },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    makeWASocket(cfg) {
      const ev = new EventEmitter();
      const sock = {
        cfg, ev, sent: [], blocked: [], ended: false, failQuoted: false,
        async sendMessage(jid, content, opts) {
          if (opts?.quoted && sock.failQuoted) throw new Error("quote failed");
          sock.sent.push({ jid, content, opts });
          return { key: { id: "SENT" } };
        },
        async requestPairingCode(number) {
          pairCalls += 1;
          if (pairAlways) throw new Error("nope");
          if (pairCalls <= pairFailures) throw new Error("not connected yet");
          return "ABCD1234";
        },
        async updateBlockStatus(jid, action) { sock.blocked.push([jid, action]); },
        end() { sock.ended = true; },
      };
      instances.push(sock);
      if (autoOpen) setImmediate(() => ev.emit("connection.update", { connection: "open" }));
      return sock;
    },
    get pairCalls() { return pairCalls; },
  };
  return lib;
}

const upsert = (sock, key, message, extra = {}) => sock.ev.emit("messages.upsert", { type: "notify", messages: [{ key, message, ...extra }] });

beforeEach(() => {
  Object.assign(wa.tuning, { connectWaitMs: 300, pairSettleMs: 1, pairRetryDelayMs: 5, reconnectBaseMs: 60_000 });
  wa.disconnectAll();
});
afterEach(() => {
  wa.disconnectAll();
  Object.assign(wa.tuning, saved);
});

function useLib(lib) {
  wa.baileysLoader.load = async () => lib;
}

describe("session lifecycle", () => {
  it("an existing session connects without pairing, then handles a command with a quoted reply", async () => {
    const lib = fakeBaileys({ registered: true, autoOpen: true });
    useLib(lib);
    const res = await wa.createSession(OWNER, { requestPairing: true });
    assert.equal(res.pairingCode, null);
    assert.equal(res.error, null);
    assert.deepEqual(wa.listSessions(), [OWNER]);
    assert.equal(db.isPaired(OWNER), true);
    const sock = lib.instances.at(-1);
    assert.equal(sock.cfg.printQRInTerminal, false);

    const m = { key: { remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: false, id: "A1" }, message: { conversation: "®ping" }, pushName: "Me" };
    sock.ev.emit("messages.upsert", { type: "notify", messages: [m] });
    await waitFor(() => sock.sent.length);
    assert.match(sock.sent[0].content.text, /🏓 PONG/);
    assert.match(sock.sent[0].content.text, /Developer: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽/);
    assert.equal(sock.sent[0].opts.quoted, m);

    // unquoted send (used by the monitor)
    await wa.sessions.get(OWNER).sendText("120363@g.us", "hello");
    const plain = sock.sent.at(-1);
    assert.equal(plain.jid, "120363@g.us");
    assert.match(plain.content.text, /hello/);
    assert.match(plain.content.text, /╭━━━〔 𝚇𝙲𝙾𝚁𝙴® 〕━━━╮/);
    assert.equal(plain.opts, undefined);

    // a failing quoted reply falls back to a plain message
    sock.failQuoted = true;
    await wa.sessions.get(OWNER).sendText(`${OWNER}@s.whatsapp.net`, "fallback", m);
    assert.match(sock.sent.at(-1).content.text, /fallback/);

    // a closed connection drops the session (and schedules a reconnect)
    sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 500 } } } });
    assert.deepEqual(wa.listSessions(), []);
  });

  it("history sync ('append') messages are never acted on", async () => {
    const lib = fakeBaileys();
    useLib(lib);
    await wa.createSession(OWNER, { requestPairing: true });
    const sock = lib.instances.at(-1);
    sock.ev.emit("messages.upsert", { type: "append", messages: [{ key: { remoteJid: `${OWNER}@s.whatsapp.net`, id: "H1" }, message: { conversation: "®ping" } }] });
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(sock.sent, []);
  });

  it("a new session requests a pairing code, retrying until WhatsApp is ready", async () => {
    const lib = fakeBaileys({ registered: false, autoOpen: false, pairFailures: 1 });
    useLib(lib);
    const res = await wa.createSession(OWNER, { requestPairing: true });
    assert.equal(res.pairingCode, "ABCD-1234");
    assert.equal(lib.pairCalls, 2); // first attempt failed, retried
    assert.deepEqual(wa.listSessions(), []); // not online until the user enters the code
  });

  it("pairing failure is reported, not thrown", async () => {
    useLib(fakeBaileys({ registered: false, autoOpen: false, pairAlways: true }));
    wa.tuning.pairAttempts = 2;
    const res = await wa.createSession(OWNER, { requestPairing: true });
    assert.equal(res.pairingCode, null);
    assert.equal(res.session, null);
    assert.match(res.error, /nope/);
  });

  it("a missing library is reported with the fix", async () => {
    wa.baileysLoader.load = async () => { throw new Error("Cannot find package '@whiskeysockets/baileys'"); };
    const res = await wa.createSession(OWNER, { requestPairing: true });
    assert.match(res.error, /npm install/);
  });

  it("invalid numbers are rejected", async () => {
    useLib(fakeBaileys());
    assert.equal((await wa.createSession("123", {})).error, "invalid phone number");
  });

  it("waitConnected resolves when the session opens later (pairing completes)", async () => {
    const lib = fakeBaileys({ registered: false, autoOpen: false });
    useLib(lib);
    const res = await wa.createSession(OWNER, { requestPairing: true });
    const sock = lib.instances.at(-1);
    const p = res.session.waitConnected(2000);
    setTimeout(() => sock.ev.emit("connection.update", { connection: "open" }), 20);
    assert.equal(await p, true);
    assert.deepEqual(wa.listSessions(), [OWNER]);
    assert.equal(await res.session.waitConnected(10), true);
  });

  it("logged-out sessions remove their dead credentials and do not reconnect", async () => {
    const lib = fakeBaileys();
    useLib(lib);
    await wa.createSession(OWNER, { requestPairing: true });
    const sock = lib.instances.at(-1);
    const folder = path.join(config.get().paths.sessions, OWNER);
    assert.ok(fs.existsSync(folder));
    sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
    assert.deepEqual(wa.listSessions(), []);
    assert.equal(fs.existsSync(folder), false);
    assert.equal(lib.instances.length, 1);
  });

  it("an unexpected close reconnects with a fresh socket", async () => {
    wa.tuning.reconnectBaseMs = 10;
    const lib = fakeBaileys();
    useLib(lib);
    await wa.createSession(OWNER, { requestPairing: true });
    lib.instances.at(-1).ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
    await waitFor(() => lib.instances.length === 2 && wa.listSessions().length === 1);
    assert.equal(lib.instances[0].ended, true);
  });

  it("disconnectSession removes credentials, registry entries and the Telegram link", async () => {
    useLib(fakeBaileys());
    await wa.createSession(OWNER, { requestPairing: true });
    db.linkTelegramUser(77, OWNER);
    assert.equal(wa.disconnectSession(OWNER), true);
    assert.deepEqual(wa.listSessions(), []);
    assert.equal(fs.existsSync(path.join(config.get().paths.sessions, OWNER)), false);
    assert.equal(db.isPaired(OWNER), false);
    assert.equal(db.telegramLinkedNumber(77), null);
    assert.equal(db.isSessionDisabled(OWNER), true);
    assert.equal(wa.disconnectSession("2349999999999"), false);
  });
});

describe("anti-bug end to end", () => {
  async function boot() {
    const lib = fakeBaileys();
    useLib(lib);
    await wa.createSession(OWNER, { requestPairing: true });
    return lib.instances.at(-1);
  }
  const dm = (id, sender = ATTACKER) => ({ remoteJid: `${sender}@s.whatsapp.net`, fromMe: false, id });

  it("a bug message gets the attacker blocked and the owner alerted", async () => {
    const sock = await boot();
    upsert(sock, dm("EV1"), { conversation: "A b ".repeat(6000) }, { pushName: "Evil" });
    await waitFor(() => sock.sent.length);
    assert.deepEqual(sock.blocked, [[`${ATTACKER}@s.whatsapp.net`, "block"]]);
    const alert = sock.sent.at(-1);
    assert.equal(alert.jid, `${OWNER}@s.whatsapp.net`);
    assert.match(alert.content.text, /THREAT COUNTERED/);
    assert.match(alert.content.text, new RegExp(`\\+${ATTACKER}`));
    assert.match(alert.content.text, /Bug strength: 90\/100/);
    assert.match(alert.content.text, /blocked on WhatsApp/);
    assert.match(alert.content.text, /Counter effectiveness: 70%/); // fake has no delete-for-me / chat wipe → reported honestly
  });

  it("per-message deletion and chat wipe use chatModify when Baileys offers it", async () => {
    const sock = await boot();
    const mods = [];
    sock.chatModify = async (mod, jid) => { mods.push([mod, jid]); };
    upsert(sock, dm("PRE1"), { conversation: "hi" }, { messageTimestamp: 1700000000 });
    upsert(sock, dm("BUG1"), { conversation: "A b ".repeat(6000) }, { messageTimestamp: 1700000001 });
    await waitFor(() => sock.sent.some((s) => /THREAT COUNTERED/.test(s.content.text ?? "")));
    assert.equal(mods.length, 2);
    assert.deepEqual(mods.map(([m]) => m.deleteForMe.key.id).sort(), ["BUG1", "PRE1"]);
    assert.equal(mods[0][0].deleteForMe.deleteMedia, false);
    assert.match(sock.sent.at(-1).content.text, /Counter effectiveness: 100%/);
  });

  it("a payload that breaks parsing is still caught", async () => {
    const sock = await boot();
    const exploding = { key: dm("X"), pushName: "Evil", get message() { throw new Error("malformed protobuf"); } };
    for (let i = 0; i < 2; i += 1) sock.ev.emit("messages.upsert", { type: "notify", messages: [exploding] });
    await waitFor(() => sock.blocked.length);
    assert.deepEqual(sock.blocked, [[`${ATTACKER}@s.whatsapp.net`, "block"]]);
  });

  it("normal chat and owner commands are unaffected", async () => {
    const sock = await boot();
    upsert(sock, dm("N1"), { conversation: "hey, are you free tonight?" });
    upsert(sock, dm("N2", OWNER), { conversation: "®ping" });
    await waitFor(() => sock.sent.length);
    assert.deepEqual(sock.blocked, []);
    assert.match(sock.sent[0].content.text, /PONG/);
  });

  it("commands typed on the paired phone itself (fromMe) run as the owner", async () => {
    const sock = await boot();
    upsert(sock, { remoteJid: "2349000000123@s.whatsapp.net", fromMe: true, id: "ME1" }, { conversation: "®checkaccess" });
    await waitFor(() => sock.sent.length);
    assert.match(sock.sent[0].content.text, /Role: OWNER/);
  });
});

describe("session primitives", () => {
  async function session(extra = {}) {
    wa.disconnectAll(); // each call starts from a clean slate
    const lib = fakeBaileys();
    useLib(lib);
    const res = await wa.createSession(OWNER, { requestPairing: true });
    const sock = lib.instances.at(-1);
    Object.assign(sock, extra);
    return [res.session, sock];
  }

  it("block / unblock call updateBlockStatus with a device-free JID", async () => {
    const [s, sock] = await session();
    await s.blockContact(`${ATTACKER}:12@s.whatsapp.net`);
    await s.unblockContact(`${ATTACKER}@s.whatsapp.net`);
    assert.deepEqual(sock.blocked, [[`${ATTACKER}@s.whatsapp.net`, "block"], [`${ATTACKER}@s.whatsapp.net`, "unblock"]]);
  });

  it("missing library support raises NotImplementedError", async () => {
    const [s] = await session();
    for (const fn of [() => s.deleteForMe("a@s.whatsapp.net", "a@s.whatsapp.net", "1"), () => s.deleteChat("a@s.whatsapp.net"), () => s.groupInfo("x@g.us")]) {
      await assert.rejects(fn(), (e) => e.name === "NotImplementedError");
    }
  });

  it("group participant updates use the participant's own id and surface failures", async () => {
    const calls = [];
    const [s] = await session({
      groupMetadata: async () => ({ participants: [{ id: "555@lid", phoneNumber: "2348000000001@s.whatsapp.net", admin: null }] }),
      groupParticipantsUpdate: async (chat, jids, action) => { calls.push([chat, jids, action]); return [{ status: "200", jid: jids[0] }]; },
    });
    await s.groupParticipants("1@g.us", ["2348000000001"], "remove");
    assert.deepEqual(calls[0], ["1@g.us", ["555@lid"], "remove"]);
    await assert.rejects(
      (async () => { const [s2] = await session({ groupMetadata: async () => ({ participants: [] }), groupParticipantsUpdate: async () => [{ status: "403" }] }); return s2.groupParticipants("1@g.us", ["2348000000001"], "remove"); })(),
      /status 403/,
    );
  });

  it("delete uses the stored message key (so LID participants stay correct)", async () => {
    const [s, sock] = await session();
    upsert(sock, { remoteJid: "1@g.us", participant: "555@lid", fromMe: false, id: "G1" }, { conversation: "x" });
    await s.deleteMessage("1@g.us", "2348000000001@s.whatsapp.net", "G1");
    assert.deepEqual(sock.sent.at(-1).content.delete, { remoteJid: "1@g.us", participant: "555@lid", fromMe: false, id: "G1" });
    await assert.rejects(s.deleteMessage("1@g.us", "x", ""), /message ID unavailable/);
  });

  it("media / contact / file senders build the right Baileys payloads", async () => {
    const [s, sock] = await session();
    const f = path.join(state.tmp, "a.png");
    fs.writeFileSync(f, "PNG");
    await s.sendImage("c@s.whatsapp.net", f, "cap");
    assert.equal(sock.sent.at(-1).content.caption, "cap");
    await s.sendFile("c@s.whatsapp.net", f, "cap2");
    assert.deepEqual([sock.sent.at(-1).content.fileName, sock.sent.at(-1).content.mimetype], ["a.png", "image/png"]);
    await s.sendAudio("c@s.whatsapp.net", f, "track");
    assert.equal(sock.sent.at(-2).content.mimetype, "audio/mpeg");
    assert.equal(sock.sent.at(-1).content.text, "track");
    await s.sendContact("c@s.whatsapp.net", "Bob", "2348000000001");
    assert.match(sock.sent.at(-1).content.contacts.contacts[0].vcard, /waid=2348000000001:\+2348000000001/);
  });

  it("device / registration lookups", async () => {
    const [s] = await session({ onWhatsApp: async (jid) => [{ jid, exists: true }], getUSyncDevices: async (jids) => [{ user: "234", device: 0, jids }] });
    assert.deepEqual(await s.isOnWhatsapp("+234 800"), [{ jid: "234800@s.whatsapp.net", exists: true }]);
    assert.equal((await s.userDevices("234800"))[0].device, 0);
    const [s2] = await session();
    await assert.rejects(s2.userDevices("234800"), /does not expose device lookup/);
  });
});

describe("message parsing", () => {
  const base = { key: { remoteJid: "120363@g.us", participant: "2349000000001@s.whatsapp.net", fromMe: false, id: "ID1" } };
  const parse = (extra, opts) => wa.parseMessage({ ...base, ...extra }, opts);

  it("extracts chat, text, sender, push name and id", () => {
    const m = parse({ message: { conversation: "®ping" }, pushName: "Zed" });
    assert.deepEqual([m.chat, m.text, m.senderNumber, m.pushName, m.messageId], ["120363@g.us", "®ping", "2349000000001", "Zed", "ID1"]);
    assert.equal(parse({ message: { extendedTextMessage: { text: "®menu" } } }).text, "®menu");
    assert.equal(parse({ message: { imageMessage: { caption: "®scan" } } }).text, "®scan");
    assert.equal(parse({ message: { videoMessage: { caption: "®scan" } } }).text, "®scan");
    assert.equal(parse({ message: { ephemeralMessage: { message: { conversation: "®ping" } } } }).text, "®ping");
    assert.equal(parse({ message: { viewOnceMessage: { message: { imageMessage: { caption: "®qr" } } } } }).text, "®qr");
  });

  it("quoted participant", () => {
    const q = parse({ message: { extendedTextMessage: { text: "®sudo", contextInfo: { participant: "2348@s.whatsapp.net" } } } });
    assert.equal(q.quotedParticipant, "2348@s.whatsapp.net");
    assert.equal(parse({ message: { conversation: "x" } }).quotedParticipant, null);
  });

  it("prefers the phone-number JID when WhatsApp sends an anonymous LID", () => {
    const k = { remoteJid: "120363@g.us", participant: "99887766@lid", fromMe: false, id: "L1" };
    for (const alt of [{ participantAlt: "2349111111111@s.whatsapp.net" }, { participantPn: "2349111111111@s.whatsapp.net" }]) {
      const m = wa.parseMessage({ key: { ...k, ...alt }, message: { conversation: ".x" } });
      assert.deepEqual([m.senderNumber, m.sender], ["2349111111111", "2349111111111@s.whatsapp.net"]);
    }
    const viaMapping = wa.parseMessage({ key: k, message: { conversation: "x" } }, { altSender: "2349222222222:5@s.whatsapp.net" });
    assert.equal(viaMapping.senderNumber, "2349222222222");
    const dm = wa.parseMessage({ key: { remoteJid: "99887766@lid", remoteJidAlt: "2349333333333@s.whatsapp.net", fromMe: false, id: "L2" }, message: { conversation: "x" } });
    assert.equal(dm.senderNumber, "2349333333333");
  });

  it("DM sender is the chat; own messages are attributed to our account", () => {
    const dm = wa.parseMessage({ key: { remoteJid: "2349000000007@s.whatsapp.net", fromMe: false, id: "D1" }, message: { conversation: "x" } });
    assert.equal(dm.senderNumber, "2349000000007");
    const own = wa.parseMessage({ key: { remoteJid: "2349000000007@s.whatsapp.net", fromMe: true, id: "D2" }, message: { conversation: "x" } }, { selfNumber: OWNER });
    assert.deepEqual([own.senderNumber, own.chat], [OWNER, "2349000000007@s.whatsapp.net"]);
  });

  it("ignores status updates, channels, empty stubs and junk", () => {
    assert.equal(wa.parseMessage({ key: { remoteJid: "status@broadcast", id: "1" }, message: { conversation: "x" } }), null);
    assert.equal(wa.parseMessage({ key: { remoteJid: "1@newsletter", id: "1" }, message: { conversation: "x" } }), null);
    assert.equal(parse({ message: undefined }), null);
    assert.equal(wa.parseMessage({}), null);
    assert.equal(wa.parseMessage(null), null);
  });

  it("payload meta: kind, mentions, vcard, wire size", () => {
    const message = {
      messageContextInfo: {}, senderKeyDistributionMessage: null,
      nativeFlowMessage: {},
      extendedTextMessage: { contextInfo: { mentionedJid: Array(300).fill("x") } },
      contactMessage: { vcard: "v".repeat(25_000) },
    };
    const meta = wa.payloadMeta({ message }, () => 90_000);
    assert.deepEqual([meta.protoSize, meta.kind, meta.mentions, meta.vcardLen], [90_000, "nativeFlowMessage", 300, 25_000]);
    const m = parse({ message }, { byteSize: () => 90_000 });
    assert.equal(m.meta.kind, "nativeFlowMessage");
    assert.equal(wa.payloadMeta({ message: {} }, () => { throw new Error("x"); }).protoSize, undefined);
  });

  it("parseMinimal keeps only who sent it and flags it", () => {
    const bad = { key: base.key, get message() { throw new Error("boom"); } };
    const mini = wa.parseMinimal(bad, new Error("boom"));
    assert.deepEqual([mini.senderNumber, mini.messageId, mini.meta.unparseable], ["2349000000001", "ID1", true]);
    assert.match(mini.meta.error, /boom/);
    assert.equal(wa.parseMinimal({}, new Error("x")), null);
  });
});
