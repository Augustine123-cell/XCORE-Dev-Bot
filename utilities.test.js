import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as config from "../src/config.js";
import * as urlguard from "../src/urlguard.js";
import { handleMessage } from "../src/whatsapp/handler.js";
import { FakeSession, OWNER, httpCalls, httpQueue, isolate, msg, resp } from "./helpers.js";

const state = isolate();

class MediaSession extends FakeSession {
  files = [];
  contacts = [];
  async sendFile(chat, file, caption) { this.files.push([chat, file, caption]); }
  async sendContact(chat, tag, number) { this.contacts.push([chat, tag, number]); }
}
async function send(text, session = new FakeSession(), opts) {
  await handleMessage(session, msg(text, opts));
  return session;
}

describe("®gitclone", () => {
  it("only accepts https repos on known hosts, sudo only", async () => {
    assert.match((await send("®gitclone")).last, /Usage: ®gitclone/);
    assert.match((await send("®gitclone https://evil.example/a/b")).last, /Only public HTTPS repositories/);
    assert.match((await send("®gitclone http://github.com/a/b")).last, /Only public HTTPS repositories/);
    assert.match((await send("®gitclone http://127.0.0.1/a/b")).last, /Private\/local/);
    assert.match((await send("®gitclone https://github.com/a/b", new FakeSession(), { sender: "2349000000090" })).last, /Sudo-only/);
  });

  it("refuses to overwrite an existing clone", async () => {
    const dir = path.join(config.get().paths.data, "cloned_repositories", "owner_repo");
    fs.mkdirSync(dir, { recursive: true });
    const out = (await send("®gitclone https://github.com/owner/repo.git")).last;
    assert.match(out, /already exists|Git is not installed/);
  });
});

describe("®mediafire", () => {
  it("resolves the download button, streams the file within the size limit and sends it", async () => {
    const html = '<a class="input" href="https://download99.mediafire.com/x/file.zip" id="downloadButton">Download</a>';
    httpQueue.push(resp(200, null, { raw: html }));
    httpQueue.push(new Response("ZIPDATA", { status: 200, headers: { "content-length": "7" } }));
    const s = new MediaSession();
    await send("®mediafire https://www.mediafire.com/file/abc/file.zip/file", s);
    assert.equal(s.files.length, 1);
    assert.equal(fs.readFileSync(s.files[0][1], "utf8"), "ZIPDATA");
    assert.match(s.last, /MEDIAFIRE DOWNLOAD/);
    assert.equal(httpCalls[1].url, "https://download99.mediafire.com/x/file.zip");
  });

  it("rejects other hosts, private direct links and oversized files", async () => {
    assert.match((await send("®mediafire https://example.com/x")).last, /Only public mediafire\.com/);
    httpQueue.push(resp(200, null, { raw: '<a href="http://10.0.0.5/f.bin" id="downloadButton">' }));
    assert.match((await send("®mediafire https://www.mediafire.com/file/a/b")).last, /download blocked/i);
    httpQueue.push(resp(200, null, { raw: '<a href="https://d.mediafire.com/f.bin" id="downloadButton">' }));
    httpQueue.push(new Response("x", { status: 200, headers: { "content-length": String(60 * 1024 * 1024) } }));
    assert.match((await send("®mediafire https://www.mediafire.com/file/a/b")).last, /50 MB/);
    httpQueue.push(resp(200, null, { raw: "<html>no button</html>" }));
    assert.match((await send("®mediafire https://www.mediafire.com/file/a/b")).last, /Could not resolve a direct/);
  });
});

describe("®save contact", () => {
  it("sends a native contact card, or falls back to text", async () => {
    const s = new MediaSession();
    await send("®save contact Bob Builder 2348000000001", s);
    assert.deepEqual(s.contacts[0].slice(1), ["Bob Builder", "2348000000001"]);
    await send("®save contact Ann", s, { quoted: "2348000000002:3@s.whatsapp.net" });
    assert.deepEqual(s.contacts[1].slice(1), ["Ann", "2348000000002"]);
    const plain = await send("®save contact Bob 2348000000001");
    assert.match(plain.last, /BEGIN:VCARD/);
    assert.match(plain.last, /TEL;TYPE=CELL:\+2348000000001/);
    assert.match((await send("®save contact Bob 123")).last, /7–15 digits/);
    assert.match((await send("®save")).last, /Usage: ®save contact/);
  });
});

describe("®readqr", () => {
  it("explains missing media support and missing decoder dependencies", async () => {
    assert.match((await send("®readqr")).last, /does not expose image downloading/);
    const s = new FakeSession();
    s.downloadMedia = async () => Buffer.from("not an image");
    const out = (await send("®readqr", s)).last;
    assert.match(out, /QR decoder dependencies are missing|Could not decode the image/);
  });

  it("download failures are reported", async () => {
    const s = new FakeSession();
    s.downloadMedia = async () => { throw new Error("no media"); };
    assert.match((await send("®readqr", s)).last, /Could not download the replied image: no media/);
  });
});

describe("OSINT", () => {
  it("®agecheck needs AGE_API_URL; static providers answer", async () => {
    assert.match((await send("®agecheck 123")).last, /AGE_API_URL is not configured/);
    process.env.AGE_API_URL = "https://age.example/api";
    config.reset();
    httpQueue.push(resp(200, { age: "2019" }));
    assert.match((await send("®agecheck 123")).last, /2019/);
    assert.match((await send("®tgfind x")).last, /not configured/);
  });
});

describe("apify", () => {
  it("error mapping", async () => {
    process.env.APIFY_TOKEN = "t";
    config.reset();
    for (const [status, frag] of [[401, /rejected the token/], [402, /insufficient funds/], [500, /HTTP 500/]]) {
      httpQueue.push(resp(status, { error: "x" }));
      assert.match((await send("®groups fashion")).sent.at(-1)[1], frag);
    }
    httpQueue.push(Object.assign(new Error("t"), { name: "TimeoutError" }));
    assert.match((await send("®groups fashion")).last, /timed out/);
    assert.match((await send("®apify run nope {}")).last, /not allowlisted/);
    assert.match((await send("®apify run groups [1]")).last, /JSON object/);
    httpQueue.push(resp(200, [{ a: 1 }, { a: 2 }]));
    assert.match((await send('®apify run groups {"keywords":["x"]}')).last, /Dataset items: 2/);
    assert.match((await send("®apify run groups {bad", new FakeSession())).last, /Invalid JSON input/);
  });
});
