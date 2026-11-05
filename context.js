/** Library-agnostic message objects. Commands only ever see these, never the WhatsApp library. */
import { BRAND_FOOTER, DEV_CREDIT } from "../format.js";

/** '234…:12@s.whatsapp.net' → '234…@s.whatsapp.net' (device suffix removed). */
export function normJid(jid) {
  const s = String(jid ?? "");
  const i = s.indexOf("@");
  if (i === -1) return s.split(":")[0];
  return `${s.slice(0, i).split(":")[0]}@${s.slice(i + 1)}`;
}

/**
 * A normalised inbound message, produced by the socket adapter.
 *   chat            chat JID, e.g. 234…@s.whatsapp.net / …@g.us
 *   sender          sender JID
 *   senderNumber    digits only
 *   quotedParticipant  JID of the author of the message being replied to
 *   messageId       WhatsApp message ID, used for safe moderation deletion
 *   raw             the library's native message, used only for quoting replies
 *   meta            payload stats from the transport: kind, protoSize, mentions, vcardLen, unparseable
 */
export function makeIncoming({
  chat, sender, senderNumber, text = "", pushName = "", quotedParticipant = null, messageId = "", raw = null, meta = {},
}) {
  return { chat, sender, senderNumber, text, pushName, quotedParticipant, messageId, raw, meta };
}

export class Ctx {
  constructor({ session, msg, args, isOwner, isSudo, cmd = "" }) {
    this.session = session;
    this.msg = msg;
    this.args = args;
    this.isOwner = isOwner;
    this.isSudo = isSudo;
    this.cmd = cmd;
    this.extra = {};
  }

  get chat() { return this.msg.chat; }
  get sender() { return this.msg.sender; }
  get senderNumber() { return this.msg.senderNumber; }
  get text() { return this.msg.text; }

  async reply(text) {
    if (!text.includes(DEV_CREDIT)) text = `${text.trimEnd()}\n\n${BRAND_FOOTER}`;
    await this.session.sendText(this.msg.chat, text, this.msg.raw);
  }
}
