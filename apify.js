import * as config from "../config.js";
import * as http from "../http.js";

export async function runActor(actorId, payload = null) {
  const cfg = config.get();
  if (!cfg.osint.apifyToken) throw new Error("APIFY_TOKEN is not configured.");
  if (!actorId) throw new Error("Apify actor ID is required.");
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs`;
  const r = await http.request("POST", url, { params: { token: cfg.osint.apifyToken }, json: payload ?? {}, timeoutMs: cfg.api.timeoutMs });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
