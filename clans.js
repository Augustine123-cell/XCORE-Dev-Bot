/** Clan tag database (data/clans.json) used by `®identify` and `®scan`. */
import fs from "node:fs";
import path from "node:path";
import * as config from "./config.js";
import * as logger from "./logger.js";
import { ValueError } from "./errors.js";

const TTL_MS = 60_000;
let cache = null;
let cacheAt = 0;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\uFE0E\uFE0F]/gu;

export function normalize(s) {
  return String(s ?? "").normalize("NFKC").replace(ZERO_WIDTH, "").trim();
}

const file = () => path.join(config.get().paths.data, "clans.json");

/** Forget the cached copy (used by tests and after external edits). */
export function resetCache() {
  cache = null;
  cacheAt = 0;
}

export function loadClans() {
  if (cache !== null && Date.now() - cacheAt < TTL_MS) return cache;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (data === null || typeof data !== "object" || !Array.isArray(data.clans)) data = { clans: [] };
  } catch (e) {
    logger.warn(`clans.json not loaded: ${e.message}`);
    data = { clans: [] };
  }
  cache = data;
  cacheAt = Date.now();
  return data;
}

export function saveClans(data) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, f);
  cache = data;
  cacheAt = Date.now();
}

export function matchName(displayName) {
  if (!displayName || typeof displayName !== "string") return [];
  const name = normalize(displayName);
  const out = [];
  for (const clan of loadClans().clans) {
    const tag = normalize(clan?.tag);
    if (tag && name.includes(tag)) out.push({ ...clan, method: "exact" });
  }
  return out;
}

export const confidence = (matches) => (matches.some((m) => m.method === "exact") ? 98 : 0);

export function addClan(clan) {
  if (!clan.name || !clan.tag) throw new ValueError("Clan name and tag are required.");
  const data = loadClans();
  data.clans = data.clans.filter((c) => normalize(c.tag) !== normalize(clan.tag));
  let members = Math.trunc(Number(clan.members || 0));
  if (!Number.isFinite(members)) members = 0;
  data.clans.push({
    name: String(clan.name).trim(),
    tag: String(clan.tag).trim(),
    description: String(clan.description || "").trim(),
    members,
    age: clan.age || "unknown",
    threat: clan.threat || "UNKNOWN",
  });
  saveClans(data);
}

export function removeClan(tag) {
  const data = loadClans();
  data.clans = data.clans.filter((c) => normalize(c.tag) !== normalize(tag));
  saveClans(data);
}

export const listClans = () => loadClans().clans;
