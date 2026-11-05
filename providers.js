import { CommandError } from "../whatsapp/commands/registry.js";

const timeoutFetch = async (url, init = {}, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

async function readJson(res) {
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const message = data?.error?.message || data?.error?.status || data?.message || `HTTP ${res.status}`;
    throw new CommandError(`AI provider error: ${message}`);
  }
  return data;
}

export async function openai({ apiKey, model, system, messages, timeoutMs, useWebSearch = false }) {
  if (!apiKey) throw new CommandError("OpenAI API key is not configured.");
  const input = [{ role: "system", content: system }, ...messages];
  const res = await timeoutFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input, temperature: 0.3, max_output_tokens: 700, ...(useWebSearch ? { tools: [{ type: "web_search" }] } : {}) }),
  }, timeoutMs);
  const data = await readJson(res);
  const text = data.output_text ?? data.output?.flatMap((x) => x.content ?? []).filter((x) => x.type === "output_text").map((x) => x.text).join("\n") ?? "";
  if (!text.trim()) throw new CommandError("OpenAI returned an empty response.");
  return text.trim();
}

export async function gemini({ apiKey, model, system, messages, timeoutMs, useWebSearch = false }) {
  if (!apiKey) throw new CommandError("Gemini API key is not configured.");
  const contents = messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await timeoutFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, ...(useWebSearch ? { tools: [{ google_search: {} }] } : {}), generationConfig: { temperature: 0.3, maxOutputTokens: 700 } }),
  }, timeoutMs);
  const data = await readJson(res);
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text.trim()) throw new CommandError("Gemini returned an empty response.");
  return text.trim();
}
