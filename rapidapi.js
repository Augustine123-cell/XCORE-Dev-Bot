import * as config from "../config.js";
import * as http from "../http.js";

export async function request(host, path, params = null, method = "GET", data = null) {
  const cfg = config.get();
  if (!cfg.osint.rapidapiKey) throw new Error("RAPIDAPI_KEY is not configured.");
  if (!host || !path) throw new Error("RapidAPI host/path not configured.");
  const headers = { "x-rapidapi-key": cfg.osint.rapidapiKey, "x-rapidapi-host": host };
  const r = await http.request(method, `https://${host}${path}`, {
    headers,
    params: method === "GET" ? params ?? undefined : undefined,
    json: data ?? undefined,
    timeoutMs: cfg.api.timeoutMs,
  });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
