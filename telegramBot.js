/** Telegram dashboard: force-join gate, WhatsApp pairing, Stars payments and owner status commands. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "./config.js";
import * as db from "./db.js";
import * as logger from "./logger.js";
import * as runtime from "./runtime.js";
import { TelegramApi, TelegramError } from "./telegram/api.js";
import { disconnectSession as defaultDisconnect } from "./whatsapp/socket.js";

export const PAIR_CONFIRM_TIMEOUT_MS = 180_000;
const XCORE_HEADER = "╭━━━〔 𝚇𝙲𝙾𝚁𝙴® 〕━━━╮";
const XCORE_FOOTER = "╰━━━━━━━━━━━━━━━━━━╯\nDeveloper: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽\nSHΔDOWBORNE LΔB 𝚇𝙲𝙾𝚁𝙴®";
const DEV_CREDIT = "Developer: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽";
const ASSET = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets", "xcore-brand.png");

export function brandText(value) {
  let text = String(value ?? "").trim();
  if (!text.startsWith(XCORE_HEADER)) text = text ? `${XCORE_HEADER}\n\n${text}` : XCORE_HEADER;
  if (!text.includes(DEV_CREDIT)) text = `${text.trimEnd()}\n\n${XCORE_FOOTER}`; // keep the footer exactly once
  return text;
}

export function ownerTelegramIds() {
  const cfg = config.get().telegram;
  return cfg.ownerIds.length ? cfg.ownerIds : [cfg.adminId];
}

const isOwnerUser = (user) => Boolean(user) && ownerTelegramIds().includes(user.id);

/** Return a public Telegram username or numeric chat ID that getChatMember can check. */
export function targetFromUrl(url) {
  const raw = String(url ?? "").trim();
  if (raw.startsWith("@")) return raw;
  if (/^-?\d+$/.test(raw)) return raw;
  let parsed;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!["t.me", "www.t.me", "telegram.me", "www.telegram.me"].includes(parsed.hostname.toLowerCase())) return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (!parts[0] || parts[0].startsWith("+") || parts[0].startsWith("joinchat")) return null;
  if (parts[0] === "c" || parts[0].startsWith("addstickers")) return null;
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(parts[0]) ? `@${parts[0]}` : null;
}

/** "/pair@MyBot arg" → { name: "pair", args: ["arg"] }; null if not a command (or addressed to another bot). */
export function parseCommand(text, botUsername = "") {
  const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return { name: m[1].toLowerCase(), args: (m[3] ?? "").split(/\s+/).filter(Boolean) };
}

const inline = (rows) => ({ inline_keyboard: rows });
const btn = (text, callback_data) => ({ text, callback_data });
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms))]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isDigits = (s) => /^\d+$/.test(s ?? "");

export class TelegramBot {
  constructor(listSessions, createSession = null, { api = null, disconnectSession = defaultDisconnect } = {}) {
    const cfg = config.get();
    this.listSessions = listSessions;
    this.createSession = createSession;
    this.disconnectSession = disconnectSession;
    this.api = api ?? new TelegramApi(cfg.telegram.token);
    this.running = false;
    this.botUsername = "";
    this.userData = new Map();
    this.abort = null;
    this.pollTask = null;
    this.commands = {
      start: (c) => this.start(c),
      pair: (c) => this.pair(c),
      status: (c) => this.status(c),
      stats: (c) => this.stats(c),
      sessions: (c) => this.sessionsCmd(c),
      admin: (c) => this.admin(c),
      pairnumber: (c, a) => this.pairnumber(c, a),
      unpair: (c, a) => this.unpair(c, a),
      paired: (c) => this.paired(c),
      ram: (c) => this.ram(c),
      grantpremium: (c, a) => this.grantpremium(c, a),
      mode: (c, a) => this.mode(c, a),
      antiban: (c, a) => this.antiban(c, a),
      buy: (c) => this.buy(c),
      revokepremium: (c, a) => this.revokepremium(c, a),
      sudoadd: (c, a) => this.sudoadd(c, a),
      sudoremove: (c, a) => this.sudoremove(c, a),
    };
  }

  // ── update plumbing ───────────────────────────────────────────────────
  #ctx(update) {
    const query = update.callback_query ?? null;
    const message = update.message ?? query?.message ?? null;
    const user = update.message?.from ?? query?.from ?? update.pre_checkout_query?.from ?? null;
    let data = null;
    if (user) {
      data = this.userData.get(user.id);
      if (!data) this.userData.set(user.id, (data = {}));
    }
    const chatId = message?.chat?.id ?? null;
    const self = this;
    return {
      update, query, message, user, chatId, data: data ?? {},
      reply: (text, extra = {}) => self.api.call("sendMessage", { chat_id: chatId, text: brandText(text), ...extra }),
      edit: (text, extra = {}) => self.#edit(query, text, extra),
      answer: (extra = {}) => self.api.call("answerCallbackQuery", { callback_query_id: query.id, ...extra }),
    };
  }

  async #edit(query, text, extra = {}) {
    try {
      return await this.api.call("editMessageText", {
        chat_id: query.message.chat.id, message_id: query.message.message_id, text: brandText(text), ...extra,
      });
    } catch (e) {
      if (e instanceof TelegramError && /not modified/i.test(e.message)) return null; // same content: nothing to do
      throw e;
    }
  }

  /** Handle one Telegram update (exposed for tests). */
  async handleUpdate(update) {
    const ctx = this.#ctx(update);
    if (await this.forceJoinGate(ctx)) return; // gate stopped processing
    if (update.pre_checkout_query) return this.precheckout(ctx);
    if (update.callback_query) {
      const d = String(update.callback_query.data ?? "");
      if (d === "check_join") return this.checkJoin(ctx);
      if (/^buy:(30|365)$/.test(d)) return this.buyCallback(ctx);
      if (d.startsWith("xadmin:")) return this.adminCallback(ctx);
      return null;
    }
    const msg = update.message;
    if (!msg) return null;
    if (msg.successful_payment) return this.successfulPayment(ctx);
    if (typeof msg.text !== "string") return null;
    const cmd = parseCommand(msg.text, this.botUsername);
    if (cmd) {
      const handler = this.commands[cmd.name];
      return handler ? handler(ctx, cmd.args) : null; // unknown commands are ignored
    }
    return this.pairPhone(ctx);
  }

  async #poll() {
    let offset;
    let failures = 0;
    while (this.running) {
      this.abort = new AbortController();
      try {
        const updates = await this.api.call(
          "getUpdates",
          { offset, timeout: 30, allowed_updates: ["message", "callback_query", "pre_checkout_query"] },
          { signal: this.abort.signal },
        );
        failures = 0;
        for (const u of updates) {
          offset = u.update_id + 1;
          // Updates run concurrently, so a long pairing wait never blocks the rest of the dashboard.
          this.handleUpdate(u).catch((e) => logger.error("telegram handler:", e));
        }
      } catch (e) {
        if (!this.running) break;
        failures += 1;
        if (e instanceof TelegramError && e.code === 409) logger.warn("Telegram: another instance is polling this bot token (409). Retrying…");
        else logger.warn(`Telegram polling error: ${e.message}`);
        await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
      }
    }
  }

  async launch(timeoutMs = 15_000) {
    const me = await withTimeout(this.api.call("getMe", {}, { timeoutMs }), timeoutMs); // also validates the token
    this.botUsername = me.username ?? "";
    await withTimeout(this.api.call("deleteWebhook", { drop_pending_updates: true }, { timeoutMs }), timeoutMs);
    this.running = true;
    this.pollTask = this.#poll();
    try {
      await this.api.call("setMyCommands", {
        commands: [
          ["start", "Open 𝚇𝙲𝙾𝚁𝙴® dashboard"], ["pair", "Pair a WhatsApp number"], ["status", "Application status"],
          ["stats", "Usage statistics"], ["sessions", "Connected WhatsApp sessions"], ["admin", "Open owner control dashboard"],
          ["pairnumber", "Owner: pair a WhatsApp number"], ["unpair", "Owner: disconnect a WhatsApp number"],
          ["paired", "Owner: list paired WhatsApp accounts"], ["ram", "Owner: process RAM usage"],
          ["antiban", "Owner: toggle antiban protection"], ["mode", "View or change bot mode"],
          ["buy", "Buy XCORE Premium with Telegram Stars"], ["grantpremium", "Owner: grant Premium"],
          ["revokepremium", "Owner: revoke Premium"], ["sudoadd", "Owner: grant WhatsApp SUDO"],
          ["sudoremove", "Owner: revoke WhatsApp SUDO"],
        ].map(([command, description]) => ({ command, description })),
      });
    } catch {
      /* command-menu setup must not prevent bot startup */
    }
  }

  async send(chatId, text) {
    return this.api.call("sendMessage", { chat_id: chatId, text: brandText(text) });
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    await Promise.race([this.pollTask, sleep(1500)]);
  }

  // ── force-join gate ───────────────────────────────────────────────────
  async #joinedAll(userId) {
    const missing = [];
    for (const url of config.get().telegram.forceJoinUrls) {
      const target = targetFromUrl(url);
      // Invite links do not expose a chat ID to Telegram's membership API; fail closed.
      if (target === null) { missing.push(url); continue; }
      try {
        const member = await this.api.call("getChatMember", { chat_id: target, user_id: userId });
        if (!["member", "administrator", "creator", "owner"].includes(String(member.status).toLowerCase())) missing.push(url);
      } catch {
        missing.push(url); // inability to verify must not bypass the gate
      }
    }
    return [missing.length === 0, missing];
  }

  #joinMarkup() {
    const rows = config.get().telegram.forceJoinUrls.map((url, i) => [{ text: `Join channel/group ${i + 1}`, url }]);
    rows.push([btn("✅ I've Joined — Check Again", "check_join")]);
    return inline(rows);
  }

  async #showJoinPrompt(ctx, edit = false) {
    const urls = config.get().telegram.forceJoinUrls;
    let text = "🔒 To use 𝚇𝙲𝙾𝚁𝙴®, join all the Telegram channels/groups below, then tap ‘I've Joined — Check Again’.";
    if (urls.some((u) => targetFromUrl(u) === null)) {
      text += "\n\n⚠️ One configured URL cannot be verified automatically. Use a public t.me/<username> link or a numeric chat ID in the environment settings.";
    }
    if (edit && ctx.query) await ctx.edit(text, { reply_markup: this.#joinMarkup() });
    else if (ctx.message) await ctx.reply(text, { reply_markup: this.#joinMarkup() });
  }

  /** Runs before every handler. Returns true when the update must not be processed further. */
  async forceJoinGate(ctx) {
    if (!config.get().telegram.forceJoinUrls.length) return false;
    if (!ctx.user || isOwnerUser(ctx.user)) return false;
    if (ctx.query && ctx.query.data === "check_join") return false;
    const [ok] = await this.#joinedAll(ctx.user.id);
    if (ok) return false;
    await this.#showJoinPrompt(ctx);
    return true;
  }

  async checkJoin(ctx) {
    await ctx.answer();
    if (!ctx.user) return;
    const [ok] = await this.#joinedAll(ctx.user.id);
    if (ok) await ctx.edit("✅ Membership verified. You can now use 𝚇𝙲𝙾𝚁𝙴®. Send /start to open the dashboard.");
    else await this.#showJoinPrompt(ctx, true);
  }

  async #guard(ctx) {
    if (isOwnerUser(ctx.user)) return true;
    if (ctx.message) await ctx.reply("⛔ Owner dashboard command. Use /pair to connect your own WhatsApp account.");
    return false;
  }

  // ── user commands ─────────────────────────────────────────────────────
  async start(ctx) {
    const urls = config.get().telegram.forceJoinUrls;
    const user = ctx.user;
    if (urls.length && user && !isOwnerUser(user)) {
      const [ok] = await this.#joinedAll(user.id);
      if (!ok) return this.#showJoinPrompt(ctx);
    }
    if (user && isOwnerUser(user)) return this.admin(ctx);
    // Telegram gets the brand image only; the XCORE soundtrack is WhatsApp-only.
    if (ctx.message && fs.existsSync(ASSET)) await this.api.sendPhoto(ctx.chatId, ASSET, "XCORE® | WhatsApp Dev Bot\nAUTOMATE • CONTROL • DOMINATE");
    await ctx.reply(
      `🩸 ${config.get().bot.name} dashboard\n\n/pair — connect your WhatsApp account\n/status — connection status\n/buy — Premium plans`,
      { reply_markup: { keyboard: [["/pair", "/status"], ["/buy"]], resize_keyboard: true, one_time_keyboard: false } },
    );
  }

  async pair(ctx) {
    if (!ctx.user || !ctx.message) return;
    if (ctx.data.pairing_in_progress) return ctx.reply("🌀 A pairing attempt is already in progress. Please wait for its result.");
    if (!this.createSession) return ctx.reply("❌ WhatsApp pairing is unavailable in this deployment.");
    ctx.data.awaiting_pair_phone = true;
    await ctx.reply("📱 Enter the WhatsApp phone number with country code.\nExample: +2348012345678\n\nSend /pair again to restart this step.");
  }

  async pairPhone(ctx) {
    if (!ctx.data.awaiting_pair_phone) return;
    const { message, user } = ctx;
    if (!message || !user) return;
    const raw = (message.text || "").trim();
    const number = raw.replace(/\D/g, "");
    if (!raw.startsWith("+") || number.length < 7 || number.length > 15) {
      return ctx.reply("❌ Invalid phone number. Include the country code, for example +2348012345678.");
    }
    delete ctx.data.awaiting_pair_phone;
    ctx.data.pairing_in_progress = true;
    try {
      await ctx.reply("🌀 Requesting pairing code… Please wait.");
      let result;
      try {
        result = await this.createSession(number, { requestPairing: true });
      } catch (exc) {
        result = { error: String(exc.message ?? exc), pairingCode: null, session: null };
      }
      const { session, pairingCode: code } = result;
      if (result.error || (!code && !(session && session.isConnected()))) return await this.#pairFailure(ctx);
      if (code) {
        await ctx.reply(
          "🔑 𝚇𝙲𝙾𝚁𝙴® PAIRING CODE\n" +
            `\n\`𝚇𝙲𝙾𝚁𝙴® • ${code}\`\n` +
            "Enter only the actual WhatsApp code after `𝚇𝙲𝙾𝚁𝙴® •` (the 𝚇𝙲𝙾𝚁𝙴® label is branding).\n\n" +
            "How to pair:\n" +
            "1. Open WhatsApp on the phone for this number.\n" +
            "2. Open Settings (or ⋮ on Android) → Linked devices.\n" +
            "3. Tap Link a device, then Link with phone number instead.\n" +
            "4. Enter the actual code shown above in WhatsApp.\n\n" +
            "Keep this code private. Waiting for WhatsApp to connect…",
          { parse_mode: "Markdown" },
        );
      }
      let connected = Boolean(session && session.isConnected());
      if (!connected && session) {
        try { connected = await session.waitConnected(PAIR_CONFIRM_TIMEOUT_MS); } catch { connected = false; }
      }
      if (connected) {
        db.linkTelegramUser(user.id, number);
        return await this.#pairSuccess(ctx);
      }
      await this.#pairFailure(ctx);
    } finally {
      delete ctx.data.pairing_in_progress;
    }
  }

  async #pairSuccess(ctx) {
    await ctx.reply(
      isOwnerUser(ctx.user)
        ? "My Lord 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽 💀 Welcome to Your Project"
        : "You're now connected to SHΔDOWBORNE ⸸ by 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽\nStatus = connected 🔗 successfully",
    );
  }

  async #pairFailure(ctx) {
    await ctx.reply(isOwnerUser(ctx.user) ? "My Lord Something Occurred... Try again or check your bot 🌚" : "You're a weak mf... try again");
  }

  // ── owner commands ────────────────────────────────────────────────────
  async status(ctx) {
    if (await this.#guard(ctx)) await ctx.reply(`🟢 ONLINE\nMode: ${db.getMode()}\nUptime: ${runtime.uptimeSeconds()}s`);
  }

  async stats(ctx) {
    if (!(await this.#guard(ctx))) return;
    const s = db.getStats();
    await ctx.reply(`📊 Checks: ${s.checks}\n🔴 Banned: ${s.banned}\n🟢 Safe: ${s.safe}`);
  }

  async sessionsCmd(ctx) {
    if (await this.#guard(ctx)) await ctx.reply(this.listSessions().map((x) => `+${x}`).join("\n") || "No active sessions.");
  }

  async mode(ctx, args) {
    if (!(await this.#guard(ctx))) return;
    if (args.length === 1) {
      try {
        db.setMode(args[0].toLowerCase());
      } catch {
        return ctx.reply("Valid modes: public, self, dev, stealth, maintenance");
      }
    }
    await ctx.reply(`Current mode: ${db.getMode()}\nUsage to change: /mode public|self|dev|stealth|maintenance`);
  }

  #adminKeyboard() {
    return inline([
      [btn("🔗 Pair WhatsApp", "xadmin:pair"), btn("📋 Paired accounts", "xadmin:paired")],
      [btn("🧠 RAM & system", "xadmin:ram"), btn("📊 Overview", "xadmin:overview")],
      [btn("⚙️ Admin controls", "xadmin:controls")],
    ]);
  }

  async admin(ctx) {
    if (!(await this.#guard(ctx))) return;
    await ctx.reply(
      "🛡️ OWNER CONTROL PANEL\n\n" +
        `Active WhatsApp sessions: ${this.listSessions().length}\nRegistered paired numbers: ${db.listPaired().length}\n` +
        `Mode: ${db.getMode()}\nUptime: ${runtime.uptimeSeconds()} seconds\n\n` +
        "Select a dashboard section below.\n" +
        "Commands: /pairnumber <number> · /unpair <number> · /grantpremium <telegram_id> <whatsapp_number> <days>",
      { reply_markup: this.#adminKeyboard() },
    );
  }

  async adminCallback(ctx) {
    await ctx.answer();
    if (!isOwnerUser(ctx.user)) return ctx.edit("⛔ Owner-only dashboard.");
    const action = String(ctx.query.data).split(":").slice(1).join(":");
    let text;
    if (action === "overview") {
      text =
        "📊 XCORE OVERVIEW\n" +
        `Active sessions: ${this.listSessions().length}\nPaired accounts: ${db.listPaired().length}\n` +
        `SUDO accounts: ${db.listSudo().length}\nPremium accounts: ${db.listPremium().length}\n` +
        `Mode: ${db.getMode()}\nUptime: ${runtime.uptimeSeconds()}s`;
    } else if (action === "paired") {
      const active = new Set(this.listSessions());
      const links = Object.fromEntries(db.listTelegramLinks().map((x) => [x.number, x.telegram_id]));
      const numbers = db.listPaired();
      const lines = numbers.map((n) => `${active.has(n) ? "🟢" : "⚪"} +${n} | Telegram: ${links[n] ?? "not linked"}`);
      const rows = numbers.slice(0, 15).map((n) => [btn(`Unpair +${n}`, `xadmin:unpair:${n}`)]);
      rows.push([btn("↩ Back to dashboard", "xadmin:overview")]);
      return ctx.edit("📋 PAIRED WHATSAPP ACCOUNTS\n\n" + (lines.length ? lines.join("\n") : "No paired accounts recorded."), { reply_markup: inline(rows) });
    } else if (action.startsWith("unpair:")) {
      const number = db.clean(action.split(":")[1]);
      if (number.length < 7 || number.length > 15) {
        text = "Invalid WhatsApp number.";
      } else {
        return ctx.edit(
          `Confirm removal of XCORE's local WhatsApp session for +${number}?\n\nThis deletes the bot's local linked-device credentials. It does not revoke other linked devices in WhatsApp settings.`,
          { reply_markup: inline([[btn("⚠️ Confirm unpair", `xadmin:unpairconfirm:${number}`)], [btn("Cancel", "xadmin:paired")]]) },
        );
      }
    } else if (action.startsWith("unpairconfirm:")) {
      const number = db.clean(action.split(":")[1]);
      const ok = this.disconnectSession(number);
      text = ok ? `✅ Local WhatsApp session for +${number} was unpaired.` : `No local session or saved credentials were found for +${number}.`;
    } else if (action === "ram") {
      text = TelegramBot.memoryReport();
    } else if (action === "controls") {
      text =
        "⚙️ ADMIN CONTROLS\n\n/pairnumber <number> — pair another WhatsApp account\n/unpair <number> — disconnect a paired account\n" +
        "/grantpremium <telegram_id> <whatsapp_number> <days>\n/revokepremium <telegram_id>\n/sudoadd <whatsapp_number>\n/sudoremove <whatsapp_number>\n" +
        "/mode <mode> — change bot mode\n/antiban on|off — toggle protection\nPremium grants: /grantpremium <telegram_id> <whatsapp_number> <days>";
    } else if (action === "pair") {
      text = "🔗 To pair an account, send:\n/pairnumber +2348012345678\n\nThe bot will return a WhatsApp linking code. Keep it private.";
    } else {
      text = "Unknown dashboard section.";
    }
    await ctx.edit(text, { reply_markup: this.#adminKeyboard() });
  }

  static memoryReport() {
    try {
      const rss = process.memoryUsage().rss;
      const total = os.totalmem();
      return (
        "🧠 SYSTEM RESOURCE USAGE\n\n" +
        `Process RAM: ${(rss / 1024 / 1024).toFixed(1)} MB\n` +
        `Host RAM: ${(total / 1024 / 1024).toFixed(1)} MB\n` +
        `Process RAM share: ${((rss / total) * 100).toFixed(2)}%`
      );
    } catch {
      return "RAM metrics are unavailable on this host.";
    }
  }

  async pairnumber(ctx, args) {
    if (!(await this.#guard(ctx))) return;
    const number = args.length === 1 ? db.clean(args[0]) : "";
    if (number.length < 7 || number.length > 15) return ctx.reply("Usage: /pairnumber <international_number>\nExample: /pairnumber +2348012345678");
    await ctx.reply(`🔄 Starting WhatsApp pairing for +${number}…`);
    let result;
    try {
      result = this.createSession ? await this.createSession(number, { requestPairing: true }) : { error: "Pairing unavailable" };
    } catch (exc) {
      result = { error: String(exc.message ?? exc) };
    }
    const { session, pairingCode: code } = result;
    if (result.error) return ctx.reply(`❌ Pairing failed: ${String(result.error).slice(0, 300)}`);
    if (code) await ctx.reply(`🔑 WHATSAPP LINKING CODE\n\n${code}\n\nEnter this in WhatsApp → Linked devices → Link with phone number. Keep it private.`);
    if (session && session.isConnected()) {
      db.addPaired(number);
      await ctx.reply(`✅ +${number} is connected and registered as a paired account.`);
    } else if (session) {
      await ctx.reply("⏳ Pairing request started. Once WhatsApp confirms the link, the account will appear in /paired. If it does not connect, retry after checking the code.");
    }
  }

  async unpair(ctx, args) {
    if (!(await this.#guard(ctx))) return;
    const number = args.length === 1 ? db.clean(args[0]) : "";
    if (number.length < 7 || number.length > 15) return ctx.reply("Usage: /unpair <whatsapp_number>");
    const disconnected = this.disconnectSession(number);
    await ctx.reply(
      `${disconnected ? "🔌 Unpaired" : "ℹ️ No local session found for"} +${number}.\nThe bot's local linked-device credentials were removed. This does not revoke other linked devices from the WhatsApp mobile app; check WhatsApp → Linked devices if you also want to revoke them there.`,
    );
  }

  async paired(ctx) {
    if (!(await this.#guard(ctx))) return;
    const active = new Set(this.listSessions());
    const links = Object.fromEntries(db.listTelegramLinks().map((x) => [x.number, x.telegram_id]));
    const lines = db.listPaired().map((n) => `${active.has(n) ? "🟢" : "⚪"} +${n} | Telegram ID: ${links[n] ?? "not linked"}`);
    await ctx.reply("📋 PAIRED ACCOUNTS\n\n" + (lines.length ? lines.join("\n") : "No paired accounts."));
  }

  async ram(ctx) {
    if (await this.#guard(ctx)) await ctx.reply(TelegramBot.memoryReport());
  }

  async antiban(ctx, args) {
    if (!(await this.#guard(ctx))) return;
    if (args.length === 1 && ["on", "off"].includes(args[0].toLowerCase())) db.setAntiban(args[0].toLowerCase() === "on");
    await ctx.reply(`Antiban protection: ${db.getAntiban() ? "ON" : "OFF"}\nUsage: /antiban on|off`);
  }

  // ── Telegram Stars ────────────────────────────────────────────────────
  async buy(ctx) {
    if (!ctx.message || !ctx.user) return;
    const cfg = config.get().telegram;
    const options = [];
    if (cfg.premium30dStars > 0) options.push(["30 days", 30, cfg.premium30dStars]);
    if (cfg.premium365dStars > 0) options.push(["365 days", 365, cfg.premium365dStars]);
    if (!options.length) return ctx.reply("💎 Premium purchases are not configured yet. Contact the owner.");
    await ctx.reply("💎 Choose a XCORE Premium plan:", {
      reply_markup: inline(options.map(([label, days, price]) => [btn(`${label} — ⭐ ${price}`, `buy:${days}`)])),
    });
  }

  async buyCallback(ctx) {
    await ctx.answer();
    const { user, query } = ctx;
    if (!user || !String(query.data).startsWith("buy:")) return;
    const days = Number.parseInt(String(query.data).split(":")[1], 10);
    if (!Number.isFinite(days)) return ctx.edit("Invalid plan selection.");
    const cfg = config.get().telegram;
    const price = days === 30 ? cfg.premium30dStars : days === 365 ? cfg.premium365dStars : 0;
    if (price <= 0) return ctx.edit("This plan is currently unavailable.");
    await this.api.call("sendInvoice", {
      chat_id: query.message.chat.id,
      title: `XCORE Premium — ${days} days`,
      description: `${days} days of 𝚇𝙲𝙾𝚁𝙴® Premium access. Developer: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽`,
      payload: `xcore-premium:${user.id}:${days}`,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: `Premium for ${days} days`, amount: price }],
    });
  }

  #expectedPrice(days) {
    const cfg = config.get().telegram;
    return days === 30 ? cfg.premium30dStars : days === 365 ? cfg.premium365dStars : 0;
  }

  async precheckout(ctx) {
    const q = ctx.update.pre_checkout_query;
    let valid;
    try {
      const parts = String(q.invoice_payload).split(":");
      valid = parts.length === 3 && parts[0] === "xcore-premium" && Number(parts[1]) === q.from.id;
      const days = valid ? Number(parts[2]) : 0;
      const expected = this.#expectedPrice(days);
      valid = valid && expected > 0 && q.currency === "XTR" && q.total_amount === expected;
    } catch {
      valid = false;
    }
    await this.api.call(
      "answerPreCheckoutQuery",
      valid ? { pre_checkout_query_id: q.id, ok: true } : { pre_checkout_query_id: q.id, ok: false, error_message: "This XCORE Premium invoice is invalid or expired." },
    );
  }

  async successfulPayment(ctx) {
    const { user, message } = ctx;
    const payment = message?.successful_payment;
    if (!user || !payment) return;
    try {
      const payload = String(payment.invoice_payload).split(":");
      if (payload.length !== 3 || payload[0] !== "xcore-premium" || Number(payload[1]) !== user.id) throw new Error("Invalid payment payload");
      const days = Number(payload[2]);
      const expected = this.#expectedPrice(days);
      if (payment.currency !== "XTR" || payment.total_amount !== expected || expected <= 0) throw new Error("Payment amount mismatch");
      const [applied, phone] = db.applyTelegramPayment(payment.telegram_payment_charge_id, user.id, days);
      if (!applied) return await ctx.reply("ℹ️ This Telegram Stars payment was already processed.");
      const status = phone
        ? `Premium activated for linked WhatsApp number +${phone}.`
        : "Payment received. Premium is reserved for your Telegram account; pair your WhatsApp number with /pair to activate it.";
      await ctx.reply(`✅ Payment successful.\n${status}\nPlan: ${days} days.`);
    } catch (exc) {
      await ctx.reply(`⚠️ Payment was received but could not be applied automatically. Contact the owner with your Telegram payment receipt.\nReference: ${exc.name}`);
    }
  }

  async grantpremium(ctx, args) {
    if (!(await this.#guard(ctx))) return;
    try {
      if (args.length === 3 && isDigits(args[0]) && isDigits(args[2])) {
        db.grantPremiumIdentity(Number(args[0]), args[1], Number(args[2]), String(ctx.user.id));
        return await ctx.reply(`💎 Premium granted.\nTelegram ID: ${args[0]}\nWhatsApp: +${db.clean(args[1])}\nDuration: ${args[2]} days.`);
      }
      if (args.length === 2 && isDigits(args[0]) && isDigits(args[1])) {
        const phone = db.grantTelegramPremium(Number(args[0]), Number(args[1]), "owner-grant");
        return await ctx.reply(phone ? `💎 Premium granted to linked number +${phone}` : "💎 Premium reserved until the user pairs WhatsApp.");
      }
    } catch (exc) {
      return ctx.reply(`❌ ${exc.message}`);
    }
    await ctx.reply("Usage: /grantpremium <telegram_user_id> <whatsapp_number> <days>\nOr: /grantpremium <telegram_user_id> <days> for an already-linked user.");
  }

  async revokepremium(ctx, args) {
    if (!(await this.#guard(ctx))) return;
    if (args.length !== 1 || !isDigits(args[0])) return ctx.reply("Usage: /revokepremium <telegram_user_id>");
    db.revokeTelegramPremium(Number(args[0]));
    await ctx.reply("💎 Telegram-linked Premium access revoked.");
  }

  async sudoadd(ctx, args) {
    if (!(await this.#guard(ctx))) return;
    const number = args.length === 1 ? db.clean(args[0]) : "";
    if (number.length < 7 || number.length > 15) return ctx.reply("Usage: /sudoadd <whatsapp_number>");
    db.addSudo(number);
    await ctx.reply(`⚔️ SUDO access granted to +${number}.`);
  }

  async sudoremove(ctx, args) {
    if (!(await this.#guard(ctx))) return;
    const number = args.length === 1 ? db.clean(args[0]) : "";
    if (!number) return ctx.reply("Usage: /sudoremove <whatsapp_number>");
    db.removeSudo(number);
    await ctx.reply(`⚔️ SUDO access removed from +${number}.`);
  }
}
