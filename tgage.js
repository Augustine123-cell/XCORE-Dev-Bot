import * as config from "../config.js";
import * as http from "../http.js";

export async function age(userId) {
  const cfg = config.get();
  if (!cfg.osint.ageApiUrl) throw new Error("AGE_API_URL is not configured.");
  const r = await http.request("GET", cfg.osint.ageApiUrl, { params: { id: String(userId) }, timeoutMs: cfg.api.timeoutMs });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
