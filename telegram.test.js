import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import * as config from "../src/config.js";
import * as db from "../src/db.js";
import { TelegramApi, TelegramError } from "../src/telegram/api.js";
import * as tg from "../src/telegramBot.js";
import { isolate, realFetchFn, waitFor } from "./helpers.js";

isolate();

const OWNER_ID = 7895316756;
const USER = { id: 424242, first_name: "Ann" };

function fakeApi(handlers = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params = {}) {
      calls.push([method, params]);
      const h = handlers[method];
      if (h instanceof Error) throw h;
      return h ? h(params) : true;
    },
    async sendPhoto(chatId, file, caption) { calls.push(["sendPhoto", { chatId, file, caption }]); return true; },
  };
}
const sentTexts = (api) => api.calls.filter(([m]) => m === "sendMessage").map(([, p]) => p.text);
const last = (api) => sentTexts(api).at(-1);
const message = (text, from = USER, extra = {}) => ({ update_id: 1, message: { message_id: 5, chat: { id: from.id }, from, text, ...extra } });
const callback = (data, from = USER) => ({ update_id: 2, callback_query: { id: "cq1", from, data, message: { message_id: 9, chat: { id: from.id } } } });

function bot(api, { createSession = null, disconnectSession = () => true } = {}) {
  return new tg.TelegramBot(() => ["2348130300032"], createSession, { api, disconnectSession });
}

describe("helpers", () => {
  it("branding is applied once", () => {
    const text = tg.brandText("hello");
    assert.ok(text.startsWith("╭━━━〔 𝚇𝙲𝙾𝚁𝙴® 〕━━━╮"));
    assert.equal(tg.brandText(text), text);
  });

  it("command parsing", () => {
    assert.deepEqual(tg.parseCommand("/pair"), { name: "pair", args: [] });
    assert.deepEqual(tg.parseCommand("/Grant@MyBot 1 2  3", "mybot"), { name: "grant", args: ["1", "2", "3"] });
    assert.equal(tg.parseCommand("/pair@OtherBot", "mybot"), null);
    assert.equal(tg.parseCommand("hello"), null);
  });
});

describe("user flows", () => {
  it("/start shows the brand image and the keyboard to normal users; owners get the panel", async () => {
    const api = fakeApi();
    const b = bot(api);
    await b.handleUpdate(message("/start"));
    assert.ok(api.calls.some(([m]) => m === "sendPhoto"));
    const params = api.calls.filter(([m]) => m === "sendMessage").at(-1)[1];
    assert.match(params.text, /dashboard/);
    assert.deepEqual(params.reply_markup.keyboard, [["/pair", "/status"], ["/buy"]]);
    const api2 = fakeApi();
    await bot(api2).handleUpdate(message("/start", { id: OWNER_ID }));
    assert.match(last(api2), /OWNER CONTROL PANEL/);
  });

  it("owner-only commands are refused for others", async () => {
    const api = fakeApi();
    for (const c of ["/status", "/stats", "/sessions", "/admin", "/ram", "/paired", "/mode", "/sudoadd 1234567"]) await bot(api).handleUpdate(message(c));
    assert.ok(sentTexts(api).every((t) => /Owner dashboard command/.test(t)));
    assert.deepEqual(db.listSudo(), []);
  });

  it("pairing: asks for a number, validates it, shows the code and confirms the link", async () => {
    const api = fakeApi();
    const session = { isConnected: () => false, waitConnected: async () => true };
    let args;
    const b = bot(api, { createSession: async (n, o) => { args = [n, o]; return { session, pairingCode: "ABCD-1234", error: null }; } });
    await b.handleUpdate(message("/pair"));
    assert.match(last(api), /Enter the WhatsApp phone number/);
    await b.handleUpdate(message("12345"));
    assert.match(last(api), /Invalid phone number/);
    await b.handleUpdate(message("+2348012345678"));
    assert.deepEqual(args, ["2348012345678", { requestPairing: true }]);
    const texts = sentTexts(api);
    assert.ok(texts.some((t) => t.includes("ABCD-1234") && t.includes("Linked devices")));
    assert.match(last(api), /connected 🔗 successfully/);
    assert.equal(db.telegramLinkedNumber(USER.id), "2348012345678");
    // plain text without /pair is ignored
    const before = api.calls.length;
    await b.handleUpdate(message("random chatter"));
    assert.equal(api.calls.length, before);
  });

  it("pairing failure and in-progress guard", async () => {
    const api = fakeApi();
    const b = bot(api, { createSession: async () => ({ session: null, pairingCode: null, error: "nope" }) });
    await b.handleUpdate(message("/pair"));
    await b.handleUpdate(message("+2348012345678"));
    assert.match(last(api), /weak mf/);
    assert.equal(db.telegramLinkedNumber(USER.id), null);
    const api2 = fakeApi();
    let release;
    const gate = new Promise((r) => { release = r; });
    const b2 = bot(api2, { createSession: async () => { await gate; return { session: null, pairingCode: null, error: "x" }; } });
    await b2.handleUpdate(message("/pair"));
    const running = b2.handleUpdate(message("+2348012345678"));
    await new Promise((r) => setTimeout(r, 20));
    await b2.handleUpdate(message("/pair"));
    assert.match(last(api2), /already in progress/);
    release();
    await running;
  });

  it("pair timeout with a code but no link is a failure", async () => {
    const api = fakeApi();
    const session = { isConnected: () => false, waitConnected: async () => false };
    const b = bot(api, { createSession: async () => ({ session, pairingCode: "ABCD-1234", error: null }) });
    await b.handleUpdate(message("/pair"));
    await b.handleUpdate(message("+2348012345678"));
    assert.match(last(api), /weak mf/);
  });
});

describe("force-join gate", () => {
  const gated = (statusFor) => {
    process.env.FORCE_JOIN_URL_1 = "https://t.me/shadowborne_news";
    process.env.FORCE_JOIN_URL_2 = "https://t.me/+privateinvite";
    config.reset();
    return fakeApi({ getChatMember: (p) => ({ status: statusFor(p) }) });
  };

  it("blocks non-members (and unverifiable invite links) with a join prompt", async () => {
    const api = gated(() => "member");
    await bot(api).handleUpdate(message("/status"));
    assert.match(last(api), /join all the Telegram channels/);
    assert.match(last(api), /cannot be verified automatically/);
    const markup = api.calls.filter(([m]) => m === "sendMessage").at(-1)[1].reply_markup;
    assert.equal(markup.inline_keyboard.at(-1)[0].callback_data, "check_join");
  });

  it("lets verified members through, always lets owners through, fails closed on API errors", async () => {
    process.env.FORCE_JOIN_URL_1 = "https://t.me/shadowborne_news";
    config.reset();
    const ok = fakeApi({ getChatMember: () => ({ status: "member" }) });
    await bot(ok).handleUpdate(message("/status"));
    assert.match(last(ok), /Owner dashboard command/); // gate passed, command ran
    const owner = fakeApi({ getChatMember: () => { throw new Error("x"); } });
    await bot(owner).handleUpdate(message("/status", { id: OWNER_ID }));
    assert.match(last(owner), /ONLINE/);
    const left = fakeApi({ getChatMember: () => ({ status: "left" }) });
    await bot(left).handleUpdate(message("/start"));
    assert.match(last(left), /join all the Telegram channels/);
    const err = fakeApi({ getChatMember: new Error("network") });
    await bot(err).handleUpdate(message("/start"));
    assert.match(last(err), /join all the Telegram channels/);
  });

  it("check_join callback verifies and updates the message", async () => {
    process.env.FORCE_JOIN_URL_1 = "https://t.me/shadowborne_news";
    config.reset();
    const api = fakeApi({ getChatMember: () => ({ status: "administrator" }) });
    await bot(api).handleUpdate(callback("check_join"));
    const edit = api.calls.find(([m]) => m === "editMessageText")[1];
    assert.match(edit.text, /Membership verified/);
    assert.ok(api.calls.some(([m]) => m === "answerCallbackQuery"));
  });
});

describe("owner dashboard", () => {
  it("mode, antiban, sudo, premium, pairnumber, unpair", async () => {
    const api = fakeApi();
    let unpaired = null;
    const b = bot(api, {
      createSession: async () => ({ session: { isConnected: () => true }, pairingCode: "WXYZ-9999", error: null }),
      disconnectSession: (n) => { unpaired = n; return true; },
    });
    const owner = (t) => b.handleUpdate(message(t, { id: OWNER_ID }));
    await owner("/mode dev");
    assert.equal(db.getMode(), "dev");
    await owner("/mode nonsense");
    assert.match(last(api), /Valid modes/);
    await owner("/antiban off");
    assert.equal(db.getAntiban(), false);
    await owner("/sudoadd +2348000000001");
    assert.equal(db.isSudo("2348000000001"), true);
    await owner("/sudoremove 2348000000001");
    assert.equal(db.isSudo("2348000000001"), false);
    await owner("/grantpremium 998877 2348000000099 45");
    assert.equal(db.isPremium("2348000000099"), true);
    await owner("/grantpremium 1 2 3 4");
    assert.match(last(api), /Usage: \/grantpremium/);
    await owner("/revokepremium 998877");
    assert.equal(db.isPremium("2348000000099"), false);
    await owner("/pairnumber +2348000000050");
    assert.ok(sentTexts(api).some((t) => t.includes("WXYZ-9999")));
    assert.match(last(api), /is connected and registered/);
    assert.equal(db.isPaired("2348000000050"), true);
    await owner("/unpair 2348000000050");
    assert.equal(unpaired, "2348000000050");
    await owner("/ram");
    assert.match(last(api), /Process RAM: [\d.]+ MB/);
    await owner("/paired");
    assert.match(last(api), /PAIRED ACCOUNTS/);
  });

  it("admin callbacks: overview, paired list, confirm-before-unpair, non-owners refused", async () => {
    db.addPaired("2348000000050");
    let unpaired = null;
    const api = fakeApi();
    const b = bot(api, { disconnectSession: (n) => { unpaired = n; return true; } });
    const as = (data, from = { id: OWNER_ID }) => b.handleUpdate(callback(data, from));
    const lastEdit = () => api.calls.filter(([m]) => m === "editMessageText").at(-1)[1];
    await as("xadmin:overview");
    assert.match(lastEdit().text, /XCORE OVERVIEW/);
    await as("xadmin:paired");
    assert.match(lastEdit().text, /\+2348000000050/);
    await as("xadmin:unpair:2348000000050");
    assert.match(lastEdit().text, /Confirm removal/);
    assert.equal(unpaired, null);
    await as("xadmin:unpairconfirm:2348000000050");
    assert.equal(unpaired, "2348000000050");
    await as("xadmin:overview", USER);
    assert.match(lastEdit().text, /Owner-only dashboard/);
  });
});

describe("Telegram Stars", () => {
  const stars = () => { process.env.PREMIUM_30D_STARS = "100"; process.env.PREMIUM_365D_STARS = "1000"; config.reset(); };

  it("/buy lists the plans; choosing one sends an XTR invoice", async () => {
    const api = fakeApi();
    await bot(api).handleUpdate(message("/buy"));
    assert.match(last(api), /not configured/);
    stars();
    await bot(api).handleUpdate(message("/buy"));
    const rows = api.calls.filter(([m]) => m === "sendMessage").at(-1)[1].reply_markup.inline_keyboard;
    assert.deepEqual(rows.map((r) => r[0].callback_data), ["buy:30", "buy:365"]);
    await bot(api).handleUpdate(callback("buy:30"));
    const invoice = api.calls.find(([m]) => m === "sendInvoice")[1];
    assert.deepEqual([invoice.currency, invoice.prices[0].amount, invoice.payload, invoice.provider_token], ["XTR", 100, `xcore-premium:${USER.id}:30`, ""]);
  });

  it("pre-checkout validates payload, currency and amount", async () => {
    stars();
    const api = fakeApi();
    const pre = (over = {}) => ({ update_id: 3, pre_checkout_query: { id: "pq", from: USER, currency: "XTR", total_amount: 100, invoice_payload: `xcore-premium:${USER.id}:30`, ...over } });
    await bot(api).handleUpdate(pre());
    assert.equal(api.calls.at(-1)[1].ok, true);
    for (const bad of [{ total_amount: 1 }, { currency: "USD" }, { invoice_payload: "xcore-premium:1:30" }, { invoice_payload: "junk" }]) {
      await bot(api).handleUpdate(pre(bad));
      assert.equal(api.calls.at(-1)[1].ok, false);
    }
  });

  it("a successful payment activates once (idempotent), reserved until pairing if unlinked", async () => {
    stars();
    const api = fakeApi();
    const pay = (charge) => message("", USER, { text: undefined, successful_payment: { currency: "XTR", total_amount: 100, invoice_payload: `xcore-premium:${USER.id}:30`, telegram_payment_charge_id: charge } });
    await bot(api).handleUpdate(pay("c1"));
    assert.match(last(api), /Premium is reserved/);
    await bot(api).handleUpdate(pay("c1"));
    assert.match(last(api), /already processed/);
    db.linkTelegramUser(USER.id, "2348000000077");
    assert.equal(db.isPremium("2348000000077"), true);
    await bot(api).handleUpdate(pay("c2"));
    assert.match(last(api), /activated for linked WhatsApp number \+2348000000077/);
    const mismatch = message("", USER, { text: undefined, successful_payment: { currency: "XTR", total_amount: 5, invoice_payload: `xcore-premium:${USER.id}:30`, telegram_payment_charge_id: "c3" } });
    await bot(api).handleUpdate(mismatch);
    assert.match(last(api), /could not be applied automatically/);
  });
});

describe("real HTTP: Bot API client and polling loop", () => {
  function mockServer() {
    const requests = [];
    let polls = 0;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const method = req.url.split("/").pop();
        const raw = Buffer.concat(chunks);
        const isJson = (req.headers["content-type"] || "").includes("json");
        const body = isJson ? JSON.parse(raw.toString() || "{}") : { multipart: true, bytes: raw.length };
        requests.push({ method, body });
        const reply = (result) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, result })); };
        if (method === "getMe") return reply({ id: 1, username: "xcore_bot" });
        if (method === "getUpdates") {
          polls += 1;
          if (polls === 1) return reply([{ update_id: 10, message: { message_id: 1, chat: { id: OWNER_ID }, from: { id: OWNER_ID }, text: "/status@xcore_bot" } }, { update_id: 11, message: { message_id: 2, chat: { id: OWNER_ID }, from: { id: OWNER_ID }, text: "/status@someone_else_bot" } }]);
          await new Promise((r) => setTimeout(r, 40));
          return reply([]);
        }
        if (method === "boom") { res.statusCode = 400; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: nope" })); }
        return reply(true);
      });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` })));
  }

  it("call() returns results and raises TelegramError", async () => {
    globalThis.fetch = realFetchFn;
    const { server, base } = await mockServer();
    try {
      const api = new TelegramApi("123:abc", { baseUrl: base });
      assert.equal((await api.call("getMe")).username, "xcore_bot");
      await assert.rejects(api.call("boom"), (e) => e instanceof TelegramError && e.code === 400 && /nope/.test(e.message));
    } finally { server.close(); }
  });

  it("launch() validates the token, polls, dispatches commands (addressed to this bot only) and stops cleanly", async () => {
    globalThis.fetch = realFetchFn;
    const { server, requests, base } = await mockServer();
    const api = new TelegramApi("123:abc", { baseUrl: base });
    const b = new tg.TelegramBot(() => [], null, { api });
    try {
      await b.launch(3000);
      assert.equal(b.botUsername, "xcore_bot");
      await waitFor(() => requests.some((r) => r.method === "sendMessage"));
      const sends = requests.filter((r) => r.method === "sendMessage");
      assert.equal(sends.length, 1); // the command for the other bot was ignored
      assert.match(sends[0].body.text, /ONLINE/);
      assert.equal(sends[0].body.chat_id, OWNER_ID);
      assert.ok(requests.some((r) => r.method === "deleteWebhook" && r.body.drop_pending_updates === true));
      assert.ok(requests.some((r) => r.method === "setMyCommands" && r.body.commands.length >= 10));
      const offsets = requests.filter((r) => r.method === "getUpdates").map((r) => r.body.offset);
      assert.ok(offsets.includes(12)); // acknowledged both updates
      // photo upload is multipart
      await api.sendPhoto(5, new URL("../src/assets/xcore-brand.png", import.meta.url).pathname, "cap");
      assert.equal(requests.at(-1).method, "sendPhoto");
      assert.equal(requests.at(-1).body.multipart, true);
    } finally {
      await b.stop();
      server.close();
    }
  });

  it("launch() fails fast on a rejected token", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), { status: 401 });
    const b = new tg.TelegramBot(() => [], null, { api: new TelegramApi("bad:token") });
    await assert.rejects(b.launch(1000), /Unauthorized/);
  });
});
