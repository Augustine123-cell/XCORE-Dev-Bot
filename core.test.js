import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as clans from "../src/clans.js";
import * as config from "../src/config.js";
import * as db from "../src/db.js";
import * as urlguard from "../src/urlguard.js";
import { targetFromUrl } from "../src/telegramBot.js";
import { OWNER, ROOT, isolate } from "./helpers.js";

const state = isolate();

describe("db", () => {
  it("roles and expiry", () => {
    assert.equal(db.getRole(OWNER), "OWNER");
    assert.equal(db.getRole("111"), "USER");
    db.addSudo("+1 (11)");
    assert.equal(db.getRole("111"), "SUDO");
    db.removeSudo("111");
    db.addPremium("222", 30);
    assert.equal(db.getRole("222"), "PREMIUM");
    db.addPremium("333", 1);
    db.load().premium.at(-1).until = db.nowMs() - 1;
    assert.equal(db.isPremium("333"), false);
    db.banUser("444", 1, "spam");
    assert.equal(db.getRole("444"), "BANNED");
    db.load().banned[0].until = db.nowMs() - 1; // temp ban lapses and self-cleans
    assert.equal(db.isBanned("444"), false);
    assert.deepEqual(db.load().banned, []);
    db.removeUser("222");
    assert.equal(db.getRole("222"), "REMOVED");
    db.restoreUser("222");
    assert.equal(db.getRole("222"), "USER");
    db.addPaired("555");
    assert.equal(db.getRole("555"), "PAIRED");
  });

  it("persists, and loads a db.json written by the older bots (partial keys)", () => {
    db.addSudo("999");
    db.addPremium("888", 0); // 0 days = permanent
    db.bumpStats(true);
    db.bumpStats(false);
    db.bumpStats(null);
    db.resetCache();
    assert.deepEqual(db.listSudo(), ["999"]);
    assert.equal(db.load().premium[0].until, null);
    assert.deepEqual(db.getStats(), { checks: 3, banned: 1, safe: 1 });
    assert.deepEqual(fs.readdirSync(config.get().paths.data).filter((f) => f.endsWith(".tmp")), []);
    fs.writeFileSync(config.get().paths.dbFile, JSON.stringify({ sudo: ["1"], mode: "dev", stats: { checks: 5 } }));
    db.resetCache();
    assert.equal(db.getMode(), "dev");
    assert.deepEqual(db.getStats(), { checks: 5, banned: 0, safe: 0 });
    assert.deepEqual(db.listMonitors(), []);
  });

  it("mode validation, monitors, names, bug log", () => {
    assert.throws(() => db.setMode("nope"), /Invalid mode/);
    db.setMode("stealth");
    assert.equal(db.getMode(), "stealth");
    assert.equal(db.addMonitor("https://a.test", "c@g.us", "1"), true);
    assert.equal(db.addMonitor("https://a.test", "c@g.us", "1"), false);
    db.removeMonitor("https://a.test");
    assert.deepEqual(db.listMonitors(), []);
    for (let i = 0; i < 2001; i += 1) db.load().names[`${i}@x`] = { name: "n", at: i };
    db.saveName("new@x", "New");
    assert.equal(Object.keys(db.load().names).length, 2002 - 500);
    assert.equal(db.getName("new@x"), "New");
    for (let i = 0; i < 250; i += 1) db.logBug({ sender: String(i) });
    assert.equal(db.load().buglog.length, 200);
    assert.equal(db.listBugs(3)[0].sender, "249");
  });

  it("Telegram premium: payment before pairing activates after pairing", () => {
    assert.equal(db.grantTelegramPremium(555001, 30), null);
    assert.equal(db.isPremium("2348000000008"), false);
    db.linkTelegramUser(555001, "2348000000008");
    assert.equal(db.isPremium("2348000000008"), true);
    assert.equal(db.telegramLinkedNumber(555001), "2348000000008");
  });

  it("Telegram premium: payment after pairing activates immediately", () => {
    db.linkTelegramUser(555002, "2348000000007");
    assert.equal(db.grantTelegramPremium(555002, 30), "2348000000007");
    assert.equal(db.isPremium("2348000000007"), true);
  });

  it("Telegram payment charge is idempotent", () => {
    db.linkTelegramUser(555003, "2348000000006");
    const [first, phone] = db.applyTelegramPayment("charge-abc", 555003, 30);
    const [second, phone2] = db.applyTelegramPayment("charge-abc", 555003, 30);
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(phone, "2348000000006");
    assert.equal(phone2, "2348000000006");
    assert.equal(db.listPremium().length, 1);
  });

  it("owner grant links Telegram + WhatsApp; unlink removes the link", () => {
    db.grantPremiumIdentity(998877, "2348000000099", 45, "test-owner");
    assert.equal(db.telegramLinkedNumber(998877), "2348000000099");
    assert.equal(db.isPremium("2348000000099"), true);
    db.linkTelegramUser(998878, "2348000000098");
    assert.deepEqual(db.listTelegramLinks().find((x) => x.telegram_id === 998878), { telegram_id: 998878, number: "2348000000098" });
    db.unlinkTelegramNumber("2348000000098");
    assert.equal(db.telegramLinkedNumber(998878), null);
  });
});

describe("clans", () => {
  it("normalisation, matching, add/remove", () => {
    clans.addClan({ name: "Raven", tag: "『𐀀』", members: null });
    assert.equal(clans.listClans()[0].members, 0);
    const hits = clans.matchName("x\u200b 『𐀀』 Bob");
    assert.equal(hits[0].name, "Raven");
    assert.equal(clans.confidence(hits), 98);
    assert.deepEqual(clans.matchName("nobody"), []);
    assert.equal(clans.confidence([]), 0);
    clans.addClan({ name: "Fallen", tag: "𝕱allen" }); // NFKC: fancy-font tag matches plain text
    assert.ok(clans.matchName("Fallen One").length);
    assert.throws(() => clans.addClan({ name: "x" }), /required/);
    clans.removeClan("𝕱allen");
    assert.equal(clans.matchName("Fallen One").length, 0);
  });

  it("bundled seed file is valid", () => {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "seed", "clans.json"), "utf8"));
    assert.ok(data.clans.length && data.clans.every((c) => "tag" in c));
  });
});

describe("urlguard", () => {
  it("blocks private/odd URLs and allows public ones", async () => {
    const bad = {
      "ftp://example.com": "Only http",
      notaurl: "Invalid URL",
      "http://": "Invalid URL",
      "http://user:pw@example.com": "credentials",
      "http://localhost:8080": "Local/private",
      "http://foo.local": "Local/private",
      "http://127.0.0.1": "Private/local IP",
      "http://10.1.2.3": "Private/local IP",
      "http://169.254.169.254/latest": "Private/local IP",
      "http://192.168.0.1": "Private/local IP",
      "http://172.20.0.1": "Private/local IP",
      "http://100.64.0.1": "Private/local IP",
      "http://2130706433": "Private/local IP", // decimal form of 127.0.0.1
      "http://[::1]/": "Private/local IP",
      "http://[::ffff:127.0.0.1]/": "Private/local IP",
      "http://[fd00::1]/": "Private/local IP",
      "http://[fe80::1]/": "Private/local IP",
      "http://example.com:99999": "Invalid URL",
    };
    for (const [url, frag] of Object.entries(bad)) {
      await assert.rejects(urlguard.assertSafeUrl(url), (e) => e instanceof urlguard.UrlBlocked && e.message.includes(frag), url);
    }
    assert.equal((await urlguard.assertSafeUrl("https://8.8.8.8/x")).hostname, "8.8.8.8");
    assert.equal((await urlguard.assertSafeUrl("http://[2606:4700:4700::1111]/")).protocol, "http:");

    urlguard.resolver.lookup = async () => [{ address: "93.184.216.34" }];
    await urlguard.assertSafeUrl("https://example.com");
    urlguard.resolver.lookup = async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }];
    await assert.rejects(urlguard.assertSafeUrl("https://rebind.example"), /resolves to a private/);
    urlguard.resolver.lookup = async () => { throw new Error("ENOTFOUND"); };
    await assert.rejects(urlguard.assertSafeUrl("https://nx.example"), /could not be resolved/);
  });
});

describe("config", () => {
  it("required vars and defaults", () => {
    let cfg = config.get();
    assert.equal(cfg.prefix, "®");
    assert.equal(cfg.api.method, "POST");
    assert.equal(cfg.api.timeoutMs, 20000);
    config.reset();
    process.env.TELEGRAM_BOT_TOKEN = "PASTE_HERE";
    assert.throws(() => config.get(), config.ConfigError);
    process.env.TELEGRAM_BOT_TOKEN = "x";
    process.env.OWNER_NUMBER = "+234 813-030-0032";
    config.reset();
    assert.equal(config.get().owner.number, "2348130300032");
    process.env.OWNER_NUMBERS = "2348130300032,+447700900123";
    process.env.OWNER_TELEGRAM_IDS = "7895316756,123456";
    process.env.FORCE_JOIN_URL_1 = "https://t.me/shadowborne_news";
    process.env.FORCE_JOIN_URL_2 = "";
    config.reset();
    cfg = config.get();
    assert.deepEqual([...cfg.owner.numbers], ["2348130300032", "447700900123"]);
    assert.deepEqual([...cfg.telegram.ownerIds], [7895316756, 123456]);
    assert.deepEqual([...cfg.telegram.forceJoinUrls], ["https://t.me/shadowborne_news"]);
  });

  it("rejects bad values", () => {
    process.env.OWNER_NUMBERS = "111111111111,222222222222,333333333333";
    assert.throws(() => config.get(), /at most two/);
    config.reset();
    delete process.env.OWNER_NUMBERS;
    process.env.BAN_CHECK_HTTP_METHOD = "TRACE";
    assert.throws(() => config.get(), /GET, POST, PUT, or PATCH/);
    config.reset();
    delete process.env.BAN_CHECK_HTTP_METHOD;
    process.env.PORT = "abc";
    assert.throws(() => config.get(), /PORT must be a valid integer/);
  });

  it("force-join target parsing", () => {
    assert.equal(targetFromUrl("https://t.me/shadowborne_news"), "@shadowborne_news");
    assert.equal(targetFromUrl("@shadowborne_news"), "@shadowborne_news");
    assert.equal(targetFromUrl("-1001234567890"), "-1001234567890");
    assert.equal(targetFromUrl("https://t.me/+privateInvite"), null);
    assert.equal(targetFromUrl("https://example.com/not-telegram"), null);
  });

  it("a real .env in the cwd does not leak into tests (XCORE_NO_DOTENV)", () => {
    const cwd = process.cwd();
    process.chdir(state.tmp);
    try {
      fs.writeFileSync(path.join(state.tmp, ".env"), "FORCE_JOIN_URL_1=https://t.me/leak\nCOMMAND_PREFIXES=!\n");
      config.reset();
      assert.equal(config.get().prefix, "®");
      assert.deepEqual([...config.get().telegram.forceJoinUrls], []);
    } finally {
      process.chdir(cwd);
    }
  });

  it("loads a .env file when dotenv is enabled and never overrides real env vars", () => {
    const cwd = process.cwd();
    process.chdir(state.tmp);
    try {
      delete process.env.XCORE_NO_DOTENV;
      fs.writeFileSync(path.join(state.tmp, ".env"), "COMMAND_PREFIXES=!,?\nBOT_MODE=dev\n");
      config.reset();
      const cfg = config.get();
      assert.deepEqual([...cfg.prefixes], ["!", "?"]);
      assert.equal(cfg.bot.mode, "public"); // BOT_MODE was already set in the environment
    } finally {
      process.chdir(cwd);
    }
  });
});
