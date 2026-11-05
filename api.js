/** Minimal Telegram Bot API client (fetch only — no dependencies). */
import fs from "node:fs";
import path from "node:path";

export class TelegramError extends Error {
  constructor(description, code = 0, parameters = null) {
    super(description);
    this.name = "TelegramError";
    this.code = code;
    this.parameters = parameters;
  }
}

export class TelegramApi {
  constructor(token, { baseUrl = "https://api.telegram.org" } = {}) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  url(method) {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  async #parse(res, method) {
    let body;
    try {
      body = await res.json();
    } catch {
      throw new TelegramError(`${method}: unreadable response (HTTP ${res.status})`, res.status);
    }
    if (!body.ok) throw new TelegramError(body.description || `${method} failed`, body.error_code || res.status, body.parameters || null);
    return body.result;
  }

  /** Call any Bot API method with JSON parameters. */
  async call(method, params = {}, { signal, timeoutMs = 40_000 } = {}) {
    const res = await globalThis.fetch(this.url(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    return this.#parse(res, method);
  }

  /** Upload a local photo with sendPhoto (multipart). */
  async sendPhoto(chatId, file, caption = "") {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption);
    form.set("photo", new Blob([fs.readFileSync(file)]), path.basename(file));
    const res = await globalThis.fetch(this.url("sendPhoto"), { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    return this.#parse(res, "sendPhoto");
  }
}
