/** Background uptime monitor: polls every registered URL once a minute. */
import * as db from "./db.js";
import * as logger from "./logger.js";
import * as http from "./http.js";
import { assertSafeUrl } from "./urlguard.js";

export const INTERVAL_MS = 60_000;
const USER_AGENT = "XCORE/1.0";
const BRAND_FOOTER = "\n\n╰━━━━━━━━━━━━━━━━━━╯\nDeveloper: 𝙳𝙴𝚅 𝙰𝚄𝚂𝚃𝙸𝙽\nSHΔDOWBORNE LΔB 𝚇𝙲𝙾𝚁𝙴®";

let timer = null;
let running = false;
let notify = null;

export function setNotifier(fn) {
  notify = fn;
}

export async function checkOne(m) {
  const t = performance.now();
  try {
    await assertSafeUrl(m.url);
    const res = await http.request("GET", m.url, { headers: { "User-Agent": USER_AGENT }, timeoutMs: 15_000, redirect: "manual" });
    return { up: res.status >= 200 && res.status < 400, status: res.status, latency: Math.round(performance.now() - t) };
  } catch (e) {
    // any failure means "down"
    return { up: false, status: 0, latency: Math.round(performance.now() - t), error: e.message };
  }
}

/** One polling pass. `check` can be injected (tests). */
export async function tick(check = checkOne) {
  for (const m of [...db.listMonitors()]) {
    const r = await check(m);
    // snapshot the previous state *before* updating the stored record
    const wasUp = m.status === "up";
    const wasDown = m.status === "down";
    const prevDownSince = m.downSince;
    const prevLastDown = m.lastDown;
    const now = db.nowMs();
    db.updateMonitor(m.url, {
      status: r.up ? "up" : "down",
      totalChecks: (m.totalChecks || 0) + 1,
      totalDown: (m.totalDown || 0) + (r.up ? 0 : 1),
      lastStatus: r.status,
      lastLatency: r.latency,
      downSince: r.up ? null : prevDownSince || now,
      lastDown: r.up ? prevLastDown : now,
    });
    if (!notify) continue;
    if (!r.up && wasUp) {
      const stamp = new Date().toISOString().slice(11, 19);
      await notify(
        m.chatJid,
        `╭━━━〔 𝚇𝙲𝙾𝚁𝙴® 〕━━━╮\n\n🔔 *SERVICE ALERT*\n\nSERVICE: ${m.url}\nSTATUS: DOWN\nLATENCY: —\nTIME: ${stamp} UTC${BRAND_FOOTER}`,
      );
    } else if (r.up && wasDown) {
      const secs = prevDownSince ? Math.floor((now - prevDownSince) / 1000) : 0;
      await notify(
        m.chatJid,
        `╭━━━〔 𝚇𝙲𝙾𝚁𝙴® 〕━━━╮\n\n🟢 *SERVICE RECOVERED*\n\n${m.url}\nDowntime: ${Math.floor(secs / 60)}m ${secs % 60}s\nStatus: ${r.status}${BRAND_FOOTER}`,
      );
    }
  }
}

async function loop() {
  while (running) {
    try {
      await tick();
    } catch (e) {
      logger.error("monitor:", e);
    }
    if (!running) break;
    await new Promise((resolve) => {
      timer = setTimeout(resolve, INTERVAL_MS);
    });
  }
}

export function start() {
  if (running) return;
  running = true;
  logger.info(`Monitor started (every ${Math.floor(INTERVAL_MS / 1000)}s)`);
  loop();
}

export function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
