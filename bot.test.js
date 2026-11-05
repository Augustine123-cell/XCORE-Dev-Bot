import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import * as api from "../src/api.js";
import * as clans from "../src/clans.js";
import * as db from "../src/db.js";
import * as fmt from "../src/format.js";
import * as monitor from "../src/monitor.js";
import * as runtime from "../src/runtime.js";
import * as server from "../src/server.js";
import { REGISTRY } from "../src/whatsapp/commands/index.js";
import { handleMessage } from "../src/whatsapp/handler.js";
import { FakeSession, OWNER, httpCalls, httpQueue, isolate, msg, resp, wait } from "./helpers.js";

isolate();

async function send(text, opts) {
  const s = new FakeSession();
  await handleMessage(s, msg(text, opts));
  return s;
}

describe("pipeline", () => {
  it("basic commands and prefixes", async () => {
    const s = await send("®ping");
    assert.equal(s.last, "🏓 PONG");
    assert.ok(s.sent[0][2], "replies quote the original");
    assert.deepEqual((await send("ping")).sent, []); // no prefix
    assert.deepEqual((await send(".")).sent, []);
    assert.deepEqual((await send(".nosuchcmd")).sent, []);
    assert.equal((await send("®PING")).last, "🏓 PONG"); // case-insensitive
    assert.match((await send("®get-id")).last, /Chat:/);
  });

  it("both prefixes work, replies are branded, and there is no bug command", async () => {
    for (const prefix of ["®", "@"]) {
      const s = await send(`${prefix}ping`);
      assert.match(s.last, /🏓 PONG/);
      assert.ok(s.sent.at(-1)[1].includes("Developer: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽"));
    }
    assert.match((await send("®botinfo")).last, /╭━━━〔 𝚇𝙲𝙾𝚁𝙴® 〕━━━╮/);
    assert.deepEqual((await send("@bug 2348000000000 Hello target")).sent, []);
    assert.equal(REGISTRY.has("bug"), false);
  });

  it("all expected commands are registered", () => {
    for (const name of ["xcore", "menu", "gitclone", "mediafire", "save", "readqr", "expel", "ordain", "strip", "jid", "purge",
      "sweepclean", "antibug", "apify", "groups", "bancheck", "monitor", "scan", "identify", "restart"]) {
      assert.ok(REGISTRY.has(name), name);
    }
  });

  it("apify help and actor list do not need a token", async () => {
    assert.match((await send("®apify help")).last, /APIFY CONTROL/);
    assert.match((await send("®apify actors")).last, /groups:/);
  });

  it("®groups reports zero after invalid links are filtered", async () => {
    process.env.APIFY_TOKEN = "tok";
    (await import("../src/config.js")).reset();
    httpQueue.push(resp(200, [
      { name: "Not a WhatsApp link", invite_url: "https://example.com/group" },
      { name: "Bad scheme", invite_url: "http://chat.whatsapp.com/invalid" },
    ]));
    const s = await send("®groups fashion NG 10");
    assert.match(s.last, /No public WhatsApp invite links found/);
    assert.doesNotMatch(s.last, /Results: 1/);
    const call = httpCalls.at(-1);
    assert.match(call.url, /lofomachines~whatsapp-group-search\/run-sync-get-dataset-items/);
    assert.deepEqual(JSON.parse(call.init.body), { keywords: ["fashion"], country: "NG", maxGroups: 10 });
    assert.equal(call.init.headers.Authorization, "Bearer tok");
  });

  it("®groups lists valid invite links", async () => {
    process.env.APIFY_TOKEN = "tok";
    (await import("../src/config.js")).reset();
    httpQueue.push(resp(200, [{ name: "Fashion NG", invite_url: "https://chat.whatsapp.com/ABC123", keyword: "fashion" }]));
    const s = await send("®groups fashion");
    assert.match(s.last, /Results: 1/);
    assert.match(s.last, /https:\/\/chat\.whatsapp\.com\/ABC123/);
  });

  it("modes", async () => {
    const user = "2349000000001";
    db.setMode("self");
    assert.equal((await send("®ping", { sender: user })).last, "🏓 PONG"); // public-ok command
    assert.match((await send("®stats", { sender: user })).last.toUpperCase(), /RESTRICTED ACCESS/);
    assert.ok((await send("®stats")).sent.length); // owner ok
    db.addSudo(user);
    assert.ok((await send("®stats", { sender: user })).sent.length); // sudo ok
    db.removeSudo(user);
    db.setMode("public");
    assert.ok((await send("®stats", { sender: user })).sent.length);
    for (const m of ["dev", "stealth"]) {
      db.setMode(m);
      assert.deepEqual((await send("®ping", { sender: user })).sent, []); // stealth/dev stay silent
      assert.ok((await send("®ping")).sent.length);
    }
    db.setMode("maintenance");
    assert.deepEqual((await send("®stats", { sender: user })).sent, []);
    assert.ok((await send("®menu", { sender: user })).sent.length);
    assert.deepEqual((await send("®ping", { sender: user })).sent, []);
  });

  it("banned/removed users get the card, owner is exempt", async () => {
    const user = "2349000000002";
    db.banUser(user, 0, "x");
    assert.match((await send("®ping", { sender: user })).last.toUpperCase(), /RESTRICTED ACCESS/);
    db.unbanUser(user);
    db.removeUser(user);
    assert.match((await send("®ping", { sender: user })).last.toUpperCase(), /RESTRICTED ACCESS/);
    db.banUser(OWNER, 0, "x");
    assert.ok((await send("®ping")).sent.length);
  });

  it("owner-only and premium locks", async () => {
    const user = "2349000000003";
    assert.equal((await send("®ban 1 0", { sender: user })).last, "❌ Owner-only command.");
    assert.equal((await send("®mode dev", { sender: user })).last, "⛔ Owner only.");
    assert.equal((await send("®monitor list", { sender: user })).last, "⛔ Sudo only.");
    assert.match((await send("®wafind x", { sender: user })).last, /Premium-only/);
    db.addPremium(user, 5);
    assert.match((await send("®wafind x", { sender: user })).last, /disabled/);
    assert.equal((await send("®self", { sender: user })).last, "❌ Sudo-only command.");
  });

  it("owner admin flow", async () => {
    const u = "2349000000004";
    assert.equal((await send(`®premium add ${u} 10`)).last, "💎 Premium added.");
    assert.equal(db.isPremium(u), true);
    assert.ok((await send("®premium list")).last.includes(`+${u} • standard • `));
    assert.equal((await send("®premium add")).last, "❌ Usage: ®premium add <number> <days>");
    assert.equal((await send(`®premium remove ${u}`)).last, "💎 Premium removed.");
    assert.equal((await send(`®ban ${u} 2 being rude`)).last, "🚫 Local ban added to User.");
    assert.equal(db.listBanned()[0].reason, "being rude");
    assert.match((await send("®banned")).last, /being rude/);
    assert.equal((await send(`®unban ${u}`)).last, "✅ Local ban removed.");
    assert.equal((await send(`®sudo ${u}`)).last, "⚔️ Sudo added.");
    assert.equal(db.isSudo(u), true);
    assert.equal((await send(`®delsudo ${u}`)).last, "⚔️ Sudo removed.");
    assert.equal((await send("®sudo")).last, "❌ Reply to a user or provide a number.");
    await send("®sudo", { quoted: `${u}:7@s.whatsapp.net` }); // reply-to-user form
    assert.equal(db.isSudo(u), true);
    assert.equal((await send(`®remove ${u}`)).last, "⛔ User removed from local bot access.");
    assert.equal(db.getRole(u), "REMOVED");
    assert.equal((await send(`®restore ${u}`)).last, "✅ User access restored.");
    assert.match((await send("®mode")).last, /Current: \*public\*/);
    assert.match((await send("®mode dev")).last, /Mode → \*dev\*/);
    assert.match((await send("®mode zzz")).last, /Unknown mode/);
    assert.equal((await send("®antiban off")).last, "🛡 Antiban OFF.");
    assert.equal((await send("®antiban")).last, "🛡 Antiban: OFF");
  });

  it("®restart exits via the supervisor", async () => {
    const codes = [];
    runtime.hooks.exit = (c) => codes.push(c);
    const s = await send("®restart");
    assert.equal(s.last, "♻️ Restarting…");
    await wait(700);
    assert.deepEqual(codes, [0]);
  });

  it("oversized owner message is logged, names are captured", async () => {
    const s = new FakeSession();
    await handleMessage(s, msg("A".repeat(20001), { name: "Alice" }));
    assert.equal(db.listBugs()[0].reason, "oversized payload");
    assert.equal(db.getName(`${OWNER}@s.whatsapp.net`), "Alice");
    assert.match((await send("®antibug")).last, /oversized payload/);
  });

  it("command errors become replies", async () => {
    assert.equal((await send("®bancheck")).last, "❌ A phone number is required.");
    httpQueue.push(new Error("boom"));
    assert.equal((await send("®bancheck 2348000000000")).last, "❌ boom");
  });

  it("®bancheck card, request shape and stats", async () => {
    httpQueue.push(resp(200, { banned: true, reason: "spam" }));
    const s = await send("®bancheck +2348000000000");
    assert.match(s.last, /🔴 BANNED/);
    assert.match(s.last, /Region: NG \(\+234\)/);
    assert.match(s.last, /Reason: spam/);
    assert.equal(db.getStats().banned, 1);
    const { init } = httpCalls.at(-1);
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { phone: "2348000000000" });
    assert.equal(init.headers.Authorization, "Bearer k");
  });

  it("misc info commands", async () => {
    for (const [cmd, frag] of [["®uptime", "UPTIME"], ["®support", "+2348130300032"], ["®buypremium", "PREMIUM"],
      ["®checkaccess", "Role: OWNER"], ["®device", "Node"], ["®session", "Active sessions: 0"], ["®stats", "STATS"],
      ["®health", "Monitors:  0"], ["®api", "Method: POST"], ["®menu", "OWNER"], ["®services", "No services monitored."]]) {
      assert.ok((await send(cmd)).last.includes(frag), cmd);
    }
  });
});

describe("devtools", () => {
  it("monitor commands", async () => {
    assert.match((await send("®monitor https://x.test")).last, /Monitoring: https:\/\/x\.test/);
    assert.match((await send("®monitor https://x.test")).last, /Already monitoring/);
    assert.match((await send("®monitor list")).last, /1\. ⚪ https:\/\/x\.test/);
    assert.match((await send("®monitor remove https://x.test")).last, /Removed monitor/);
    assert.deepEqual(db.listMonitors(), []);
    assert.match((await send("®monitor http://localhost")).last, /Local\/private/);
  });

  it("®api-test", async () => {
    httpQueue.push(resp(200, { banned: false }));
    const ok = await send("®api-test");
    assert.match(ok.last, /𝚇𝙲𝙾𝚁𝙴® API TEST/);
    assert.match(ok.last, /Status: REACHABLE/);
    assert.match(ok.last, /Latency:/);
    assert.deepEqual(JSON.parse(httpCalls.at(-1).init.body), { phone: "0000000000" });
    httpQueue.push(new Error("provider unavailable"));
    const failed = await send("®api-test");
    assert.match(failed.last, /Status: FAILED/);
    assert.match(failed.last, /provider unavailable/);
  });

  it("®apilab and ®watch", async () => {
    httpQueue.push(resp(200, { a: 1 }, { headers: { "content-type": "application/json", server: "nginx" } }));
    let s = await send("®apilab get https://x.test");
    assert.match(s.last, /Status:  200 OK/);
    assert.match(s.last, /Server:  nginx/);
    assert.equal(httpCalls.at(-1).init.method, "GET");
    httpQueue.push(resp(200, {}));
    await send("®api headers https://x.test"); // ®api delegates to apilab
    assert.equal(httpCalls.at(-1).init.method, "GET");
    httpQueue.push(new Error("timed out"));
    assert.match((await send("®watch https://x.test")).last, /Error: timed out/);
    httpQueue.push(resp(204));
    assert.match((await send("®watch https://x.test")).last, /Status: 204/);
    assert.match((await send("®apilab trace https://x.test")).last, /Unsupported method: trace/);
    assert.match((await send("®apilab")).last.replace("𝗔𝗣𝗜 𝗟𝗔𝗕𝗢𝗥𝗔𝗧𝗢𝗥𝗬", "API LABORATORY"), /API LABORATORY/);
    assert.match((await send("®apilab get http://10.0.0.1")).last, /Private\/local IP/);
  });

  it("®scan / ®identify", async () => {
    clans.addClan({ name: "Raven Clan", tag: "『𐀀』" });
    db.saveName("2349000000009@s.whatsapp.net", "Bob 『𐀀』");
    const s = await send("®scan", { quoted: "2349000000009:3@s.whatsapp.net" });
    assert.match(s.last, /Clan name   : Raven Clan/);
    assert.match(s.last, /Confidence  : 98%/);
    assert.match((await send("®scan 2340000000000")).last, /NOT FOUND/);
    assert.match((await send("®scan 2349000000009")).last, /Clan name   : Raven Clan/);
    assert.match((await send("®scan list")).last, /Raven Clan/);
    assert.match((await send("®scan add Foo | ⟁ | desc")).last, /Added clan: Foo \(⟁\)/);
    assert.match((await send("®scan add onlyname")).last, /Usage: ®scan add/);
    assert.match((await send("®scan")).last, /Usage:/);
    assert.match((await send("®scan abc")).last, /Invalid number/);
    // non-sudo users may only use ®identify
    assert.match((await send("®scan list", { sender: "2349000000044" })).last, /Sudo only/);
    assert.match((await send("®identify 2340000000000", { sender: "2349000000044" })).last, /NOT FOUND/);
  });
});

describe("monitor", () => {
  it("alerts on up→down, not on repeats, and reports real downtime on recovery", async () => {
    db.addMonitor("https://svc.test", "chat@g.us", "1");
    const alerts = [];
    monitor.setNotifier(async (chat, text) => { alerts.push([chat, text]); });
    const seq = [{ up: true, status: 200, latency: 5 }, { up: false, status: 0, latency: 9 }, { up: false, status: 500, latency: 9 }, { up: true, status: 200, latency: 4 }];
    const check = async () => seq.shift();
    await monitor.tick(check); // unknown → up : no alert
    assert.equal(alerts.length, 0);
    await monitor.tick(check); // up → down : alert
    assert.equal(alerts.length, 1);
    assert.match(alerts[0][1], /STATUS: DOWN/);
    const since = db.listMonitors()[0].downSince;
    assert.ok(since);
    await monitor.tick(check); // still down: no repeat alert, downSince preserved
    assert.equal(alerts.length, 1);
    assert.equal(db.listMonitors()[0].downSince, since);
    db.listMonitors()[0].downSince = db.nowMs() - 125_000; // pretend it's been down 2m05s
    await monitor.tick(check); // down → up
    assert.equal(alerts.length, 2);
    assert.match(alerts[1][1], /Downtime: 2m 5s/);
    const m = db.listMonitors()[0];
    assert.deepEqual([m.status, m.totalChecks, m.totalDown, m.downSince], ["up", 4, 2, null]);
    monitor.setNotifier(null);
  });

  it("checkOne uses the SSRF guard; 3xx counts as up; 5xx is down", async () => {
    const r = await monitor.checkOne({ url: "http://127.0.0.1/" });
    assert.equal(r.up, false);
    assert.match(r.error, /Private\/local/);
    httpQueue.push(resp(301, {}));
    assert.equal((await monitor.checkOne({ url: "https://x.test" })).up, true);
    httpQueue.push(resp(503, {}));
    assert.equal((await monitor.checkOne({ url: "https://x.test" })).up, false);
  });
});

describe("api client", () => {
  it("interprets provider responses", async () => {
    const cases = [[{ banned: false }, false], [{ isBanned: "yes" }, true], [{ status: "Not Banned" }, false],
      [{ status: "weird" }, null], [{}, null], [{ blocked: "true", reason: "r" }, true]];
    for (const [body, expected] of cases) {
      httpQueue.push(resp(200, body));
      assert.equal((await api.checkBan("123")).banned, expected, JSON.stringify(body));
    }
    httpQueue.push(resp(403, {}));
    await assert.rejects(api.checkBan("123"), /HTTP 403/);
    httpQueue.push(resp(200, null)); // non-JSON body
    assert.equal((await api.checkBan("123")).banned, null);
    assert.throws(() => api.normalizePhone("abc"), /required/);
  });

  it("GET providers get the phone as a query parameter", async () => {
    process.env.BAN_CHECK_HTTP_METHOD = "GET";
    (await import("../src/config.js")).reset();
    httpQueue.push(resp(200, { banned: false }));
    await api.checkBan("+234 800");
    const { url, init } = httpCalls.at(-1);
    assert.match(url, /\?phone=234800$/);
    assert.equal(init.body, undefined);
  });
});

describe("format", () => {
  it("region and menu by role", () => {
    assert.equal(fmt.region("2348000"), "NG (+234)");
    assert.equal(fmt.region("27821234567"), "ZA (+27)");
    assert.equal(fmt.region("14155550123"), "US (+1)");
    assert.equal(fmt.region("447700900123"), "UK (+44)");
    assert.equal(fmt.region("91999"), "Unknown");
    const user = fmt.menu("2349000000010");
    assert.match(user, /Buy premium/);
    assert.doesNotMatch(user, /®watch/);
    db.addPremium("2349000000010", 5);
    assert.match(fmt.menu("2349000000010"), /®wafind/);
    const owner = fmt.menu(OWNER);
    for (const frag of ["®restore", "®restart", "®scan (reply)", "𝗠𝗢𝗗𝗘: PUBLIC", "®gitclone", "®mediafire", "®save contact", "®readqr", "®expel", "®apify"]) {
      assert.ok(owner.includes(frag), frag);
    }
    assert.match(fmt.restrictedCard().toUpperCase(), /RESTRICTED ACCESS/);
    db.banUser("2349000000011", 3, "bad");
    const card = fmt.accessCard("2349000000011");
    assert.match(card, /Role: BANNED/);
    assert.match(card, /Reason: bad/);
    assert.match(card, /Until: [23] days/);
  });

  it("branding wraps unbranded text exactly once", () => {
    const text = fmt.brandMessage("A test response");
    assert.ok(text.startsWith("╭━━━〔 𝚇𝙲𝙾𝚁𝙴® 〕━━━╮"));
    assert.equal(text.split("Developer: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽").length - 1, 1);
    assert.equal(fmt.brandMessage(text), text);
  });

  it("localStamp looks like a timestamp with a zone", () => {
    assert.match(fmt.localStamp(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+/);
  });
});

describe("health server", () => {
  it("serves JSON status", async () => {
    const srv = await server.start(() => 2);
    try {
      const { port } = srv.address();
      const { body, headers } = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/`, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ body: JSON.parse(data), headers: res.headers }));
        }).on("error", reject);
      });
      assert.equal(headers["cache-control"], "no-store");
      assert.deepEqual([body.status, body.sessions, body.mode, body.name], ["online", 2, "public", "𝚇𝙲𝙾𝚁𝙴®"]);
      assert.ok(body.ts.endsWith("Z"));
    } finally {
      await server.stop();
    }
  });
});
