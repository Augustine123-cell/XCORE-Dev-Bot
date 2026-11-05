/**
 * Tiny fetch wrapper. It looks up globalThis.fetch at call time so tests can stub it.
 * Never follows redirects on its own (SSRF guard: every hop must be re-validated by the caller).
 */
export async function request(method, url, { headers = {}, json, params, timeoutMs = 20000, redirect = "manual", signal } = {}) {
  let target = String(url);
  if (params) {
    const u = new URL(target);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    target = u.toString();
  }
  const init = { method, headers: { ...headers }, redirect, signal: signal ?? AbortSignal.timeout(timeoutMs) };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    if (!Object.keys(init.headers).some((h) => h.toLowerCase() === "content-type")) init.headers["Content-Type"] = "application/json";
  }
  return globalThis.fetch(target, init);
}

/** Parse a JSON body, returning undefined when it is not valid JSON. */
export async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export const isTimeout = (e) => e && (e.name === "TimeoutError" || e.name === "AbortError");
