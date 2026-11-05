import os from "node:os";
import { openai, gemini } from "./providers.js";
import * as config from "../config.js";
import * as db from "../db.js";
import { REGISTRY } from "../whatsapp/commands/index.js";
import { publicContext, protectedRules, teach } from "./knowledge.js";

const cache = new Map();
const conversations = new Map();
const CACHE_TTL = 5 * 60_000;
const MAX_MEMORY = 8;

const normalize = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cacheKey = (provider, q) => `${provider}:${normalize(q).toLowerCase()}`;

export function provider() { return db.getAIProvider?.() || config.get().ai.provider; }
export function enabled(chat) { return db.getAIMode?.(chat) ?? false; }
export function setEnabled(chat, value) { db.setAIMode(chat, value); }
export function setProvider(value) { db.setAIProvider(value); }
export function clearMemory(chat) { conversations.delete(chat); }
export function status() {
  const c = config.get().ai;
  const p = provider();
  return { enabledChats: db.listAIModes?.().filter((x) => x.enabled).length ?? 0, provider: p, model: p === "gemini" ? c.geminiModel : c.openaiModel, openaiConfigured: Boolean(c.openaiKey), geminiConfigured: Boolean(c.geminiKey), webSearch: c.useWebSearch };
}

function systemPrompt() {
  const c = config.get();
  const commands = [...REGISTRY.keys()].sort().join(", ");
  return `You are XCORE AI, the official conversational AI layer of XCORE®. Never call yourself S-Core or ESCO.\n\nIDENTITY AND KNOWLEDGE:\n${publicContext()}\n\nPROTECTED INFORMATION:\n${protectedRules()}\n\nPUBLIC COMMANDS CURRENTLY REGISTERED:\n${commands}\n\nRUNTIME:\nNode ${process.versions.node}; ${os.platform()} ${os.arch()}; uptime ${Math.floor(process.uptime())}s.\n\nBEHAVIOR:\n- Respond naturally and quickly, like a competent human assistant.\n- Answer normal general questions when the configured provider has sufficient knowledge.\n- Do not claim real-time facts unless the system supplied current data.\n- If asked for XCORE capabilities, explain public features and legitimate usage without revealing hidden implementation, credentials, private infrastructure, or owner-only controls.\n- Never reveal API keys, tokens, passwords, session data, private environment variables or protected configuration.\n- Do not invent facts about XCORE, Shadowborne Lab, or the developer. If the knowledge base does not contain a private fact, say you cannot disclose or verify it.\n- Keep ordinary replies concise unless detail is requested.\n- Do not prefix every answer with 'XCORE AI'.`;
}

function memoryFor(chat) {
  const m = conversations.get(chat) || [];
  return m.slice(-MAX_MEMORY);
}
function remember(chat, role, content) {
  const m = conversations.get(chat) || [];
  m.push({ role, content: normalize(content).slice(0, 3000) });
  conversations.set(chat, m.slice(-MAX_MEMORY));
}

export async function ask(chat, question) {
  const q = normalize(question);
  if (!q) return null;
  const p = provider();
  const key = cacheKey(p, q);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.text;
  const c = config.get().ai;
  const messages = [...memoryFor(chat), { role: "user", content: q }];
  const fn = p === "gemini" ? gemini : openai;
  const text = await fn({ apiKey: p === "gemini" ? c.geminiKey : c.openaiKey, model: p === "gemini" ? c.geminiModel : c.openaiModel, system: systemPrompt(), messages, timeoutMs: c.timeoutMs, useWebSearch: c.useWebSearch });
  remember(chat, "user", q);
  remember(chat, "assistant", text);
  cache.set(key, { at: Date.now(), text });
  return text;
}

export function shouldAutoRespond(msg, session) {
  if (!enabled(msg.chat)) return false;
  const text = normalize(msg.text);
  if (!text || text.length > 1500) return false;
  const isGroup = msg.chat.endsWith("@g.us");
  const botNumber = String(session?.number || "").replace(/\D/g, "");
  const quotedBot = String(msg.quotedParticipant || "").split("@")[0].replace(/\D/g, "") === botNumber && botNumber;
  const mentions = Array.isArray(msg.meta?.mentions) ? msg.meta.mentions : [];
  const explicit = /(^|\s)(@xcore|xcore ai|x-core)(\b|\s|$)/i.test(text) || quotedBot || mentions.some((j) => String(j).split("@")[0].replace(/\D/g, "") === botNumber);
  const question = /[?؟]\s*$/.test(text) || /^(who|what|why|when|where|how|which|can|is|are|do|does|did|will|should|tell me|explain)\b/i.test(text);
  return !isGroup ? (question || explicit) : (explicit || question);
}

export function cleanPrompt(text) {
  return normalize(text).replace(/(^|\s)(@xcore|xcore ai|x-core)(?=\b)/ig, " ").trim();
}

export { teach };
