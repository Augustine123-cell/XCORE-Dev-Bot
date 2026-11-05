/** Shared test fixtures: isolated env + temp dirs, a stubbed fetch, fake sessions. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "node:test";
import * as clans from "../src/clans.js";
import * as config from "../src/config.js";
import * as db from "../src/db.js";
import * as urlguard from "../src/urlguard.js";
import * as runtime from "../src/runtime.js";
import { resetRuntimeState } from "../src/whatsapp/security.js";
import { makeIncoming } from "../src/whatsapp/context.js";

export const OWNER = "2348130300032";
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// Every variable the app reads. Cleared before each test so a developer's real shell/.env/Railway
// settings can never leak in.
const ISOLATED_ENV = (
  "AGE_API_URL APIFY_TOKEN APIFY_USER_ID APIFY_ACTORS BAN_CHECKER_API_KEY BAN_CHECKER_API_URL BAN_CHECK_API_KEY_HEADER " +
  "BAN_CHECK_API_KEY_PREFIX BAN_CHECK_HTTP_METHOD BAN_CHECK_PHONE_FIELD BOT_MODE BOT_NAME COMMAND_PREFIX COMMAND_PREFIXES " +
  "DEV_NAME FORCE_JOIN_URL_1 FORCE_JOIN_URL_2 FORCE_JOIN_URL_3 OWNER_NUMBER OWNER_NUMBERS " +
  "OWNER_TELEGRAM_IDS PORT RAPIDAPI_KEY REQUEST_TIMEOUT_MS TELEGRAM_ADMIN_ID TELEGRAM_BOT_TOKEN " +
  "DATA_DIR SESSION_DIR PERSIST_DIR PREMIUM_30D_STARS PREMIUM_365D_STARS"
).split(" ");

export const httpQueue = [];
export const httpCalls = [];
const realFetch = globalThis.fetch;
export const realFetchFn = realFetch;

/** Build a Response (null-body statuses must not carry a body). */
export function resp(status = 200, body = {}, { headers = {}, statusText = "OK", raw = null } = {}) {
  const nullBody = [101, 204, 205, 304].includes(status);
  const payload = nullBody ? null : raw ?? (body === null ? "not json" : JSON.stringify(body));
  return new Response(payload, { status, statusText, headers });
}

/** Registers beforeEach/afterEach hooks. Returns an object exposing the per-test temp dir. */
export function isolate() {
  const state = { tmp: "" };
  let savedEnv;
  let savedLookup;
  let savedExit;
  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const k of Object.keys(process.env)) if (ISOLATED_ENV.includes(k) || k.startsWith("RAILWAY_")) delete process.env[k];
    state.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sbtest-"));
    Object.assign(process.env, {
      XCORE_NO_DOTENV: "1",
      TELEGRAM_BOT_TOKEN: "123:abc",
      BAN_CHECKER_API_KEY: "k",
      DATA_DIR: path.join(state.tmp, "data"),
      SESSION_DIR: path.join(state.tmp, "sessions"),
      OWNER_NUMBER: OWNER,
      BOT_MODE: "public",
      PORT: "0",
    });
    config.reset();
    db.resetCache();
    clans.resetCache();
    resetRuntimeState();
    httpQueue.length = 0;
    httpCalls.length = 0;
    globalThis.fetch = async (url, init = {}) => {
      httpCalls.push({ url: String(url), init });
      if (!httpQueue.length) throw new Error("No mocked HTTP response queued");
      const item = httpQueue.shift();
      if (item instanceof Error) throw item;
      return item;
    };
    savedLookup = urlguard.resolver.lookup;
    urlguard.resolver.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    savedExit = runtime.hooks.exit;
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k]; // restore in place (process.env must stay the real object)
    Object.assign(process.env, savedEnv);
    globalThis.fetch = realFetch;
    urlguard.resolver.lookup = savedLookup;
    runtime.hooks.exit = savedExit;
    fs.rmSync(state.tmp, { recursive: true, force: true });
  });
  return state;
}

export const BRAND_MARKER = "\n\n╰━━━━━━━━━━━━━━━━━━╯\nDeveloper: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽";

/** Fake WhatsApp session that just records what the bot sends. */
export class FakeSession {
  number = OWNER;
  sent = [];
  async sendText(chat, text, quoted = null) { this.sent.push([chat, text, quoted]); }
  get last() {
    if (!this.sent.length) return null;
    const text = this.sent.at(-1)[1];
    return text.includes(BRAND_MARKER) ? text.split(BRAND_MARKER)[0] : text;
  }
}

export function msg(text, { sender = OWNER, chat = null, name = "", quoted = null, id = "" } = {}) {
  return makeIncoming({
    chat: chat ?? `${sender}@s.whatsapp.net`, sender: `${sender}@s.whatsapp.net`, senderNumber: sender,
    text, pushName: name, quotedParticipant: quoted, messageId: id, raw: {},
  });
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await wait(15);
  }
  throw new Error("timed out waiting for condition");
}
