/**
 * Where persistent state lives (db.json, clans.json, WhatsApp sessions).
 *
 * Resolution order for each directory:
 *   1. DATA_DIR / SESSION_DIR                    – explicit override
 *   2. PERSIST_DIR or RAILWAY_VOLUME_MOUNT_PATH  – a mounted volume: <mount>/data and <mount>/sessions
 *   3. ./data and ./sessions                     – local development only (WIPED on every container redeploy)
 *
 * Railway lets a service have ONE volume, so data and sessions share it (<mount>/data, <mount>/sessions).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "seed");

function canWrite(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function pick(candidates) {
  for (const c of candidates) {
    try {
      fs.mkdirSync(c, { recursive: true });
      if (canWrite(c)) return path.resolve(c);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function resolveReal(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Mount path of a persistent volume if the host provides one (and it is writable). */
export function volumeRoot() {
  for (const name of ["PERSIST_DIR", "RAILWAY_VOLUME_MOUNT_PATH"]) {
    const v = (process.env[name] || "").trim();
    if (v) return pick([resolveReal(v)]);
  }
  return null;
}

function resolveDir(envName, folder) {
  const env = (process.env[envName] || "").trim();
  if (env) return path.resolve(env);
  const root = volumeRoot();
  const tmp = path.join(os.tmpdir(), `xcore-${folder}`);
  if (root) return pick([path.join(root, folder)]) || tmp;
  return pick([path.join(process.cwd(), folder), path.join(os.homedir(), ".shadowborne", folder), tmp]) || tmp;
}

export const dataDir = () => resolveDir("DATA_DIR", "data");
export const sessionDir = () => resolveDir("SESSION_DIR", "sessions");

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function under(p, root) {
  const rel = path.relative(resolveReal(root), resolveReal(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True if any parent directory of `p` (excluding '/') is a mount point. */
function onMount(p) {
  let cur = resolveReal(p);
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    try {
      if (fs.statSync(cur).dev !== fs.statSync(parent).dev) return true;
    } catch {
      /* ignore */
    }
    cur = parent;
  }
}

/** Describe where state is stored and whether it will survive a redeploy. */
export function status(data = null, sessions = null) {
  data = data ? path.resolve(data) : dataDir();
  sessions = sessions ? path.resolve(sessions) : sessionDir();
  const root = volumeRoot();
  const onRailway = ["RAILWAY_ENVIRONMENT", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID"].some((k) => k in process.env);
  const inContainer = fs.existsSync("/.dockerenv") || onRailway;
  const warnings = [];
  if (onRailway) {
    if (!root) {
      warnings.push(
        "No Railway volume detected — db.json and WhatsApp sessions are WIPED on every deploy. " +
          "Add a volume to this service (mount path e.g. /data).",
      );
    } else if (!(under(data, root) && under(sessions, root))) {
      warnings.push(`DATA_DIR/SESSION_DIR are outside the volume (${root}) — that data is wiped on every deploy.`);
    }
  } else if (inContainer && !root && !(onMount(data) && onMount(sessions))) {
    warnings.push("Running in a container with no mounted volume — data will not survive a redeploy.");
  }
  return { data, sessions, volume: root, persistent: warnings.length === 0, warnings };
}

/** Create the directories and copy bundled defaults (clans.json) in if missing. Never overwrites. */
export function bootstrap(data = null, sessions = null) {
  const st = status(data, sessions);
  ensureDir(st.data);
  ensureDir(st.sessions);
  const seeded = [];
  if (fs.existsSync(SEED_DIR) && fs.statSync(SEED_DIR).isDirectory()) {
    for (const name of fs.readdirSync(SEED_DIR)) {
      const src = path.join(SEED_DIR, name);
      const dst = path.join(st.data, name);
      if (fs.statSync(src).isFile() && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        seeded.push(name);
      }
    }
  }
  st.seeded = seeded;
  return st;
}
