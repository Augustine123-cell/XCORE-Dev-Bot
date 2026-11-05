/** WhatsApp group administration commands (®ordain ®strip ®ban ®purge ®sweepclean ®jid). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeIncoming } from "../src/whatsapp/context.js";
import { handleMessage } from "../src/whatsapp/handler.js";
import { OWNER, isolate } from "./helpers.js";

isolate();

class FakeGroupSession {
  number = OWNER;
  constructor(members) { this.members = members; this.sent = []; this.actions = []; this.deleted = []; }
  async sendText(chat, text, quoted) { this.sent.push([chat, text, quoted]); }
  async groupInfo() { return { Participants: this.members }; }
  async groupParticipants(chat, numbers, action) { this.actions.push([chat, numbers, action]); }
  async deleteMessage(chat, sender, id) { this.deleted.push([chat, sender, id]); }
}

const members = () => [
  { JID: "2348130300032@s.whatsapp.net", IsAdmin: true },
  { JID: "2348000000001@s.whatsapp.net", IsAdmin: false },
  { JID: "2348000000002@s.whatsapp.net", IsAdmin: true },
  { JID: "2348000000003@s.whatsapp.net", IsSuperAdmin: true },
];

async function run(text, session, { sender = OWNER, chat = "120363000000000000@g.us" } = {}) {
  await handleMessage(session, makeIncoming({ chat, sender: `${sender}@s.whatsapp.net`, senderNumber: sender, text, pushName: "Tester", messageId: "cmd-1" }));
  return session.sent.length ? session.sent.at(-1)[1] : "";
}

describe("group commands", () => {
  it("®ordain, ®strip and ®ban use the group API", async () => {
    const s = new FakeGroupSession(members());
    assert.match(await run("®ordain 2348000000001", s), /promoted/);
    assert.equal(s.actions.at(-1)[2], "promote");
    assert.match(await run("@strip 2348000000002", s), /privileges removed/);
    assert.equal(s.actions.at(-1)[2], "demote");
    assert.match(await run("®ban 2348000000001", s), /Removed/);
    assert.equal(s.actions.at(-1)[2], "remove");
  });

  it("®purge is owner-only; ®sweepclean needs a confirmation", async () => {
    const s = new FakeGroupSession(members());
    assert.match(await run("®purge", s), /Demoted: 1/);
    assert.deepEqual(s.actions.at(-1)[1], ["2348000000002"]);
    assert.equal(s.actions.at(-1)[2], "demote");

    s.actions.length = 0;
    assert.match(await run("®sweepclean", s), /Eligible members to remove: 1/);
    assert.deepEqual(s.actions, []);
    assert.match(await run("®sweepclean confirm", s), /Removed: 1/);
    assert.deepEqual(s.actions.at(-1)[1], ["2348000000001"]);
  });

  it("®sweepclean confirm without a preview is refused", async () => {
    const s = new FakeGroupSession(members());
    assert.match(await run("®sweepclean confirm", s), /No active sweep confirmation/);
  });

  it("protections: creator, owner and the bot cannot be removed; non-admins cannot operate", async () => {
    const s = new FakeGroupSession(members());
    assert.match(await run("®ban 2348000000003", s), /group creator cannot be modified/);
    assert.match(await run("®strip 2348130300032", s), /owner numbers are protected|bot's own account is protected/);
    assert.match(await run("®ban 2348999999999", s), /not a member/);
    assert.deepEqual(s.actions, []);
    assert.match(await run("®ordain 2348000000002", s, { sender: "2348000000001" }), /Only the bot owner, SUDO, or a group administrator/);
  });

  it("the bot must be a group admin", async () => {
    const s = new FakeGroupSession([{ JID: `${OWNER}@s.whatsapp.net`, IsAdmin: false }, { JID: "2348000000001@s.whatsapp.net", IsAdmin: false }]);
    assert.match(await run("®ban 2348000000001", s), /must be a group administrator/);
  });

  it("®jid works in a group and is refused in a private chat", async () => {
    const s = new FakeGroupSession(members());
    assert.match(await run("@jid", s), /120363000000000000@g\.us/);
    const s2 = new FakeGroupSession(members());
    assert.match(await run("@jid", s2, { chat: `${OWNER}@s.whatsapp.net` }), /inside a WhatsApp group/);
  });

  it("®ban in a private chat is the local access ban", async () => {
    const s = new FakeGroupSession(members());
    assert.match(await run("®ban 2349000000050 0 test", s, { chat: `${OWNER}@s.whatsapp.net` }), /Local ban added/);
    assert.deepEqual(s.actions, []);
  });
});
