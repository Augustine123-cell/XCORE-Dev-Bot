/** Environment configuration. Call get() — it throws ConfigError if required vars are missing. */
import path from "node:path";
import * as paths from "./paths.js";

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const req = (name) => {
  const v = (process.env[name] ?? "").trim();
  if (!v || v === "PASTE_HERE") throw new ConfigError(`Missing env: ${name}`);
  return v;
};

const opt = (name, def) => {
  const v = process.env[name];
  return v === undefined || v === null || !String(v).trim() ? def : String(v).trim();
};

const num = (name, def) => {
  const raw = opt(name, String(def));
  if (!/^[+-]?\d+$/.test(raw)) throw new ConfigError(`${name} must be a valid integer`);
  return Number.parseInt(raw, 10);
};

const digits = (s) => String(s ?? "").replace(/\D/g, "");
const unique = (arr) => [...new Set(arr)];

function loadDotenv() {
  if (process.env.XCORE_NO_DOTENV || process.env.SHADOWBORNE_NO_DOTENV) return;
  try {
    process.loadEnvFile(path.join(process.cwd(), ".env")); // never overrides variables that are already set
  } catch {
    /* no .env file — hosts like Railway use real environment variables */
  }
}

function build() {
  loadDotenv();
  const data = paths.dataDir();
  const sessions = paths.sessionDir();

  const primaryOwner = digits(opt("OWNER_NUMBER", "2348130300032"));
  const ownerNumbers = [];
  for (const raw of opt("OWNER_NUMBERS", primaryOwner).split(",")) {
    const n = digits(raw);
    if (n && !ownerNumbers.includes(n)) ownerNumbers.push(n);
  }
  if (primaryOwner && !ownerNumbers.includes(primaryOwner)) ownerNumbers.unshift(primaryOwner);
  if (ownerNumbers.length > 2) throw new ConfigError("OWNER_NUMBERS supports at most two WhatsApp owner numbers");
  if (!ownerNumbers.length || ownerNumbers.some((n) => n.length < 7 || n.length > 15)) {
    throw new ConfigError("OWNER_NUMBER/OWNER_NUMBERS must contain valid international phone numbers (7–15 digits)");
  }

  const adminId = num("TELEGRAM_ADMIN_ID", 7895316756);
  const ownerIds = [];
  for (const raw of opt("OWNER_TELEGRAM_IDS", String(adminId)).split(",")) {
    const t = raw.trim();
    if (!/^[+-]?\d+$/.test(t)) throw new ConfigError("OWNER_TELEGRAM_IDS must be comma-separated Telegram numeric IDs");
    const v = Number.parseInt(t, 10);
    if (!ownerIds.includes(v)) ownerIds.push(v);
  }
  if (ownerIds.length > 2) throw new ConfigError("OWNER_TELEGRAM_IDS supports at most two Telegram owner IDs");

  const forceJoinUrls = [opt("FORCE_JOIN_URL_1", ""), opt("FORCE_JOIN_URL_2", ""), opt("FORCE_JOIN_URL_3", "")]
    .map((x) => x.trim())
    .filter(Boolean);

  const method = opt("BAN_CHECK_HTTP_METHOD", "POST").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH"].includes(method)) {
    throw new ConfigError("BAN_CHECK_HTTP_METHOD must be GET, POST, PUT, or PATCH");
  }
  const timeoutMs = num("REQUEST_TIMEOUT_MS", 20000);
  if (timeoutMs <= 0) throw new ConfigError("REQUEST_TIMEOUT_MS must be greater than zero");
  const port = num("PORT", 3000);
  if (port < 0 || port > 65535) throw new ConfigError("PORT must be between 0 and 65535");

  let prefixes = unique(opt("COMMAND_PREFIXES", "®,@").split(",").map((x) => x.trim()).filter(Boolean));
  if (!prefixes.length) prefixes = ["®", "@"];

  const actors = opt("APIFY_ACTORS", "groups=lofomachines~whatsapp-group-search")
    .split(",")
    .filter((item) => item.includes("="))
    .map((item) => {
      const i = item.indexOf("=");
      return [item.slice(0, i).trim().toLowerCase(), item.slice(i + 1).trim()];
    })
    .filter(([alias, actor]) => alias && actor);

  return Object.freeze({
    owner: Object.freeze({ number: primaryOwner, name: opt("DEV_NAME", "𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽"), numbers: Object.freeze(ownerNumbers) }),
    bot: Object.freeze({ name: opt("BOT_NAME", "𝚇𝙲𝙾𝚁𝙴®"), mode: opt("BOT_MODE", "public") }),
    telegram: Object.freeze({
      token: req("TELEGRAM_BOT_TOKEN"),
      adminId,
      ownerIds: Object.freeze(ownerIds),
      forceJoinUrls: Object.freeze(forceJoinUrls),
      premium30dStars: Math.max(0, num("PREMIUM_30D_STARS", 0)),
      premium365dStars: Math.max(0, num("PREMIUM_365D_STARS", 0)),
    }),
    api: Object.freeze({
      url: opt("BAN_CHECKER_API_URL", "https://baron0.com/api/v2/check"),
      key: req("BAN_CHECKER_API_KEY"),
      header: opt("BAN_CHECK_API_KEY_HEADER", "Authorization"),
      prefix: opt("BAN_CHECK_API_KEY_PREFIX", "Bearer"),
      method,
      phoneField: opt("BAN_CHECK_PHONE_FIELD", "phone"),
      timeoutMs,
    }),
    ai: Object.freeze({
      provider: opt("AI_PROVIDER", "openai").toLowerCase() === "gemini" ? "gemini" : "openai",
      openaiKey: opt("OPENAI_API_KEY", ""),
      openaiModel: opt("OPENAI_MODEL", "gpt-4.1-mini"),
      geminiKey: opt("GEMINI_API_KEY", ""),
      geminiModel: opt("GEMINI_MODEL", "gemini-2.5-flash"),
      useWebSearch: opt("AI_USE_WEB_SEARCH", "true").toLowerCase() === "true",
      timeoutMs: Math.max(1000, num("AI_TIMEOUT_MS", 12000)),
    }),
    osint: Object.freeze({
      apifyToken: opt("APIFY_TOKEN", ""),
      apifyUserId: opt("APIFY_USER_ID", ""),
      apifyActors: Object.freeze(actors),
      rapidapiKey: opt("RAPIDAPI_KEY", ""),
      ageApiUrl: opt("AGE_API_URL", ""),
    }),
    prefix: prefixes[0],
    prefixes: Object.freeze(prefixes),
    paths: Object.freeze({ data, sessions, dbFile: path.join(data, "db.json") }),
    port,
  });
}

let cfg = null;

export function get() {
  if (cfg === null) cfg = build();
  return cfg;
}

/** Drop the cached config (used by tests). */
export function reset() {
  cfg = null;
}
