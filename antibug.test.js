/** Anti-bug engine: detection scoring, auto-block, purge, shield, effectiveness, commands. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as db from "../src/db.js";
import { NotImplementedError } from "../src/errors.js";
import { makeIncoming } from "../src/whatsapp/context.js";
import { handleMessage } from "../src/whatsapp/handler.js";
import { analyzePayload, combine, effectiveness, inspectMessage, levelFor, resetRuntimeState, strengthBar } from "../src/whatsapp/security.js";
import { OWNER, isolate } from "./helpers.js";

isolate();

const ATTACKER = "2349011112222";
const GROUP = "120363000000000000@g.us";

class BugSession {
  number = OWNER;
  constructor({ members = [], block = "ok", dmDelete = "ok", chatWipe = false } = {}) {
    Object.assign(this, { members, blockMode: block, dmDeleteMode: dmDelete, chatWipe });
    this.sent = []; this.blocked = []; this.deleted = []; this.dmDeleted = []; this.chatsWiped = []; this.unblocked = [];
  }
  async sendText(chat, text) { this.sent.push([chat, text]); }
  async groupInfo() { return { Participants: this.members }; }
  async deleteMessage(chat, sender, id) { this.deleted.push([chat, sender, id]); }
  async blockContact(jid) {
    if (this.blockMode === "fail") throw new Error("server said no");
    if (this.blockMode === "unsupported") throw new NotImplementedError("no blocklist api");
    await new Promise((r) => setImmediate(r));
    this.blocked.push(jid);
  }
  async unblockContact(jid) { this.unblocked.push(jid); }
  async deleteForMe(chat, sender, id) {
    if (this.dmDeleteMode === "unsupported") throw new NotImplementedError("nope");
    this.dmDeleted.push([chat, id]);
  }
  async deleteChat(chat) {
    if (!this.chatWipe) throw new NotImplementedError("nope");
    this.chatsWiped.push(chat);
  }
}

const incoming = (text = "hello", { sender = ATTACKER, chat = null, mid = "m1", meta = {}, name = "Attacker" } = {}) =>
  makeIncoming({ chat: chat ?? `${sender}@s.whatsapp.net`, sender: `${sender}@s.whatsapp.net`, senderNumber: sender, text, messageId: mid, pushName: name, meta });

const keys = (text, meta) => Object.fromEntries(analyzePayload(text, meta).map((s) => [s.key, s.points]));
const BIG = "A b ".repeat(6000); // ~24 KB → strength 90

describe("analyzer", () => {
  it("normal messages are clean", () => {
    const samples = ["hello", "®menu", "Good morning 😀🙏 how are you?", "a ".repeat(1500), "مرحبا كيف حالك؟ ".repeat(20),
      "नमस्ते आप कैसे हैं ".repeat(30), "check https://a.com https://b.com https://c.com", "😂".repeat(200),
      "Line one\nLine two\n\tindented", "Ẹ kú àárọ̀, báwo ni? ".repeat(40)];
    for (const t of samples) assert.deepEqual(keys(t), {}, t.slice(0, 30));
  });

  it("oversized", () => {
    assert.equal(keys("A b ".repeat(3500)).oversized, 60);
    assert.equal(keys("A b ".repeat(6000)).oversized, 90);
  });

  it("control / invisible / combining", () => {
    assert.equal(keys("hi" + "\x00".repeat(25)).controls, 55);
    assert.equal(keys("\x01".repeat(250)).controls, 85);
    assert.equal(keys("hi" + "\u202e".repeat(40)).invisible, 55);
    assert.equal(keys("\u200b".repeat(400)).invisible, 85);
    assert.equal(keys("a" + "\u0301".repeat(120)).combining, 70);
    assert.equal(keys("a" + "\u0301".repeat(500)).combining, 85);
  });

  it("runs, links, mentions", () => {
    assert.ok("charrun" in keys("x".repeat(3500)));
    assert.ok("token" in keys("ab".repeat(2500)));
    assert.equal(keys(Array(9).fill("https://x.io").join(" ")).urls, 60);
    assert.equal(keys(Array.from({ length: 15 }, (_, i) => `@2348000000${String(i).padStart(3, "0")}`).join(" "))["mentions-text"], 60);
  });

  it("transport meta", () => {
    assert.equal(keys("", { mentions: 250 })["mentions-meta"], 60);
    assert.equal(keys("", { mentions: 1500 })["mentions-meta"], 85);
    assert.equal(keys("", { protoSize: 70_000 }).proto, 50);
    assert.equal(keys("", { protoSize: 300_000 }).proto, 85);
    assert.equal(keys("", { vcardLen: 30_000 }).vcard, 60);
    assert.equal(keys("", { unparseable: true, error: "x" }).unparseable, 45);
    assert.equal(keys("", { kind: "nativeFlowMessage" }).kind, 20);
    assert.deepEqual(keys("", { kind: "imageMessage" }), {});
  });

  it("strength levels and combination", () => {
    assert.equal(combine([]), 0);
    assert.equal(combine([60]), 60);
    assert.equal(combine([60, 60]), 81);
    assert.equal(combine([90, 90, 90]), 100);
    assert.deepEqual([10, 45, 70, 95].map(levelFor), ["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
    assert.equal(strengthBar(80), "▰".repeat(8) + "▱".repeat(2));
    assert.equal(strengthBar(85), "▰".repeat(8) + "▱".repeat(2)); // Python-style rounding of 8.5 → 8
  });

  it("effectiveness math", () => {
    const on = { autoblock: true, autopurge: true };
    assert.equal(effectiveness("ok", 5, 5, true, on), 100);
    assert.equal(effectiveness("ok", 0, 5, true, on), 70);
    assert.equal(effectiveness("failed", 5, 5, true, on), 50);
    assert.equal(effectiveness("failed", 0, 5, true, on), 20);
    assert.equal(effectiveness("ok", 3, 6, true, on), 85);
    assert.equal(effectiveness("skipped", 5, 5, true, { autoblock: false, autopurge: true }), 100);
  });
});

describe("counter", () => {
  it("DM bug is blocked, purged and reported at 100%", async () => {
    const s = new BugSession();
    for (let i = 0; i < 3; i += 1) assert.equal(await inspectMessage(s, incoming("hi", { mid: `pre${i}` })), null);
    const report = await inspectMessage(s, incoming(BIG, { mid: "bug" }));
    assert.ok(report.countered);
    assert.equal(report.strength, 90);
    assert.deepEqual(s.blocked, [`${ATTACKER}@s.whatsapp.net`]);
    assert.equal(s.dmDeleted.length, 4); // 3 earlier + the bug itself
    assert.equal(report.outcome.effectiveness, 100);
    assert.equal(db.antibugShieldGet(ATTACKER).waBlocked, true);
    assert.ok(!s.sent.some(([c]) => c === `${ATTACKER}@s.whatsapp.net`)); // never message the attacker
    const alert = s.sent.find(([c]) => c === `${OWNER}@s.whatsapp.net`)[1];
    assert.match(alert, /Bug strength: 90\/100/);
    assert.match(alert, /CRITICAL/);
    assert.match(alert, /Counter effectiveness: 100%/);
    const log = db.listBugs()[0];
    assert.deepEqual([log.reason, log.action, log.blocked, log.deleted], ["oversized payload", "countered", true, 4]);
  });

  it("without delete support it is honest about it", async () => {
    const report = await inspectMessage(new BugSession({ dmDelete: "unsupported" }), incoming(BIG));
    assert.equal(report.outcome.effectiveness, 70); // block 50 + shield 20
    assert.match(report.outcome.purge_note, /delete unsupported/);
  });

  it("chat-wipe fallback counts as purged", async () => {
    const s = new BugSession({ dmDelete: "unsupported", chatWipe: true });
    const report = await inspectMessage(s, incoming(BIG));
    assert.deepEqual(s.chatsWiped, [`${ATTACKER}@s.whatsapp.net`]);
    assert.equal(report.outcome.effectiveness, 100);
  });

  it("block failure lowers effectiveness but the shield still holds", async () => {
    let i = 0;
    for (const [mode, note] of [["fail", "server said no"], ["unsupported", "no blocklist api"]]) {
      resetRuntimeState();
      const attacker = `234901111${String(i++).padStart(4, "0")}`;
      const s = new BugSession({ block: mode });
      const report = await inspectMessage(s, incoming(BIG, { sender: attacker }));
      assert.equal(report.outcome.block, mode === "fail" ? "failed" : "unsupported");
      assert.equal(report.outcome.effectiveness, 50); // purge 30 + shield 20
      assert.equal(db.antibugShieldGet(attacker).waBlocked, false);
      assert.ok(s.sent[0][1].includes(note));
    }
  });

  it("a session without any primitives still counters", async () => {
    const sent = [];
    const bare = { number: OWNER, sendText: async (c, t) => sent.push([c, t]) };
    const report = await inspectMessage(bare, incoming(BIG));
    assert.ok(report.countered);
    assert.equal(report.outcome.effectiveness, 20); // only the bot shield is confirmed
  });

  it("shield drops follow-ups and the pipeline stops", async () => {
    const s = new BugSession();
    await inspectMessage(s, incoming(BIG));
    const before = s.sent.length;
    await handleMessage(s, incoming("®ping", { mid: "after" }));
    assert.equal(s.sent.length, before); // no command reply
    assert.ok(s.dmDeleted.some(([c, id]) => c === `${ATTACKER}@s.whatsapp.net` && id === "after"));
  });

  it("DM flood threshold", async () => {
    const s = new BugSession();
    for (let i = 0; i < 9; i += 1) assert.equal(await inspectMessage(s, incoming(`msg ${i}`, { mid: `f${i}` })), null);
    const report = await inspectMessage(s, incoming("msg 9", { mid: "f9" }));
    assert.ok(report.countered);
    assert.equal(report.primary, "message flood");
    assert.equal(s.dmDeleted.length, 10);
  });

  it("a concurrent burst counters exactly once", async () => {
    const s = new BugSession();
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => inspectMessage(s, incoming(BIG, { mid: `c${i}` }))));
    assert.equal(s.blocked.length, 1);
    assert.equal(results.filter((r) => r && r.countered).length, 1);
    assert.ok(results.every((r) => r && r.handled));
    assert.equal(s.sent.filter(([c]) => c === `${OWNER}@s.whatsapp.net`).length, 1);
  });

  it("an unparseable payload needs two strikes", async () => {
    const s = new BugSession();
    const meta = { unparseable: true, error: "KeyError: x" };
    assert.equal(await inspectMessage(s, incoming("", { mid: "u1", meta })), null);
    const report = await inspectMessage(s, incoming("", { mid: "u2", meta }));
    assert.ok(report.countered);
    assert.equal(report.primary, "repeated unparseable payloads");
  });

  it("exempt numbers are logged, never blocked", async () => {
    db.addSudo("2348000000055");
    db.antibugTrust("2348000000066");
    for (const who of [OWNER, "2348000000055", "2348000000066"]) {
      const s = new BugSession();
      assert.equal(await inspectMessage(s, incoming(BIG, { sender: who })), null);
      assert.deepEqual([s.blocked, s.dmDeleted, s.sent], [[], [], []]);
      assert.equal(db.listBugs()[0].action, "exempt");
      assert.equal(db.antibugShieldGet(who), null);
    }
  });

  it("group bug blocks, deletes, mutes and alerts the group", async () => {
    const members = [{ JID: `${OWNER}@s.whatsapp.net`, IsAdmin: true }, { JID: `${ATTACKER}@s.whatsapp.net`, IsAdmin: false }];
    const s = new BugSession({ members });
    let report;
    for (let i = 0; i < 7; i += 1) report = await inspectMessage(s, incoming("spam", { chat: GROUP, mid: `g${i}` }));
    assert.ok(report.countered);
    assert.equal(s.deleted.length, 7);
    assert.deepEqual(s.blocked, [`${ATTACKER}@s.whatsapp.net`]);
    assert.ok(db.getMute(GROUP, ATTACKER));
    assert.ok(s.sent.some(([c]) => c === GROUP));
    assert.equal(report.outcome.effectiveness, 100);
  });

  it("group without admin rights reports partial", async () => {
    const members = [{ JID: `${OWNER}@s.whatsapp.net`, IsAdmin: false }, { JID: `${ATTACKER}@s.whatsapp.net`, IsAdmin: false }];
    const s = new BugSession({ members });
    const report = await inspectMessage(s, incoming(BIG, { chat: GROUP }));
    assert.deepEqual(s.deleted, []);
    assert.equal(report.outcome.effectiveness, 70);
    assert.match(report.outcome.purge_note, /bot is not a group admin/);
  });

  it("a group admin attacker is not touched", async () => {
    const members = [{ JID: `${OWNER}@s.whatsapp.net`, IsAdmin: true }, { JID: `${ATTACKER}@s.whatsapp.net`, IsAdmin: true }];
    const s = new BugSession({ members });
    assert.equal(await inspectMessage(s, incoming(BIG, { chat: GROUP })), null);
    assert.deepEqual(s.blocked, []);
  });

  it("Baileys-shaped group metadata (admin: 'admin' | null, phoneNumber) works too", async () => {
    const members = [{ id: "111@lid", phoneNumber: `${OWNER}@s.whatsapp.net`, admin: "admin" }, { id: "222@lid", phoneNumber: `${ATTACKER}@s.whatsapp.net`, admin: null }];
    const s = new BugSession({ members });
    for (let i = 0; i < 7; i += 1) await inspectMessage(s, incoming("spam", { chat: GROUP, mid: `b${i}` }));
    assert.equal(s.deleted.length, 7);
    assert.equal(s.blocked.length, 1);
  });

  it("settings switches", async () => {
    db.setAntibugOption("autoblock", false);
    const s = new BugSession();
    const report = await inspectMessage(s, incoming(BIG));
    assert.deepEqual([s.blocked, report.outcome.block, report.outcome.effectiveness], [[], "skipped", 100]);
    db.setAntibugOption("enabled", false);
    const s2 = new BugSession();
    assert.equal(await inspectMessage(s2, incoming(BIG, { sender: "2349022223333" })), null);
    assert.deepEqual(s2.blocked, []);
  });

  it("sensitivity threshold", async () => {
    const s = new BugSession();
    const text = "a" + "\u0301".repeat(120); // strength 70
    db.setAntibugOption("threshold", 75);
    assert.equal(await inspectMessage(s, incoming(text)), null);
    db.setAntibugOption("threshold", 45);
    assert.ok((await inspectMessage(s, incoming(text, { mid: "m2" }))).countered);
  });

  it("group flood: 7th message triggers the soft mute and later messages are deleted", async () => {
    const members = [{ JID: `${OWNER}@s.whatsapp.net`, IsAdmin: true }, { JID: "2348000000009@s.whatsapp.net", IsAdmin: false }];
    const s = new BugSession({ members });
    const mk = (text, mid) => makeIncoming({ chat: GROUP, sender: "2348000000009@s.whatsapp.net", senderNumber: "2348000000009", text, messageId: mid, pushName: "Spammer" });
    for (let i = 0; i < 7; i += 1) await inspectMessage(s, mk("spam repeated content", `m${i}`));
    assert.equal(s.deleted.length, 7);
    assert.ok(db.getMute(GROUP, "2348000000009"));
    await inspectMessage(s, mk("still here", "m8"));
    assert.equal(s.deleted.length, 8);
  });
});

describe("®antibug command", () => {
  async function runCmd(text, sender = OWNER) {
    resetRuntimeState();
    const s = new BugSession();
    await handleMessage(s, incoming(text, { sender, name: "Owner" }));
    return [s, s.sent.at(-1)?.[1] ?? ""];
  }

  it("status, on/off, level, trust, list, unblock", async () => {
    let [, out] = await runCmd("®antibug status");
    assert.match(out, /Protection: ON/);
    await runCmd("®antibug level high");
    assert.equal(db.antibugSettings().threshold, 45);
    [, out] = await runCmd("®antibug level bogus");
    assert.match(out, /Sensitivity: high/);
    await runCmd("®antibug block off");
    await runCmd("®antibug purge off");
    const st = db.antibugSettings();
    assert.deepEqual([st.autoblock, st.autopurge], [false, false]);
    await runCmd("®antibug off");
    assert.equal(db.antibugSettings().enabled, false);
    await runCmd("®antibug on");
    assert.equal(db.antibugSettings().enabled, true);
    await runCmd("®antibug trust +2348010000001");
    assert.equal(db.antibugTrusted("2348010000001"), true);
    await runCmd("®antibug untrust 2348010000001");
    assert.equal(db.antibugTrusted("2348010000001"), false);
    db.antibugShieldAdd(ATTACKER, 88, "oversized payload", true);
    [, out] = await runCmd("®antibug list");
    assert.match(out, new RegExp(`\\+${ATTACKER}`));
    assert.match(out, /WA-blocked/);
    let s;
    [s, out] = await runCmd(`®antibug unblock ${ATTACKER}`);
    assert.match(out, /removed from the shield/);
    assert.match(out, /WhatsApp block lifted/);
    assert.deepEqual(s.unblocked, [`${ATTACKER}@s.whatsapp.net`]);
    assert.equal(db.antibugShieldGet(ATTACKER), null);
  });

  it("log shows strength and effectiveness, and is sudo-only", async () => {
    await inspectMessage(new BugSession(), incoming(BIG));
    let [, out] = await runCmd("®antibug");
    assert.match(out, /oversized payload/);
    assert.match(out, /90\/100/);
    assert.match(out, /effectiveness 100%/);
    [, out] = await runCmd("®antibug status", "2348000000077");
    assert.match(out, /Sudo-only/);
  });
});
