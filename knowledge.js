import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "../config.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "knowledge");
const SEED = {
  identity: {
    name: "XCORE AI",
    platform: "XCORE® WhatsApp Developer Bot",
    developer: "DEV AUSTIN / Augustine Uchechi",
    laboratory: "SHΔDOWBORNE LΔB",
    role: "Conversational AI layer for the XCORE platform",
  },
  public: {
    description: "XCORE® is a WhatsApp developer and automation platform providing developer utilities, GitHub controls, project analysis, system monitoring, media/sticker utilities, deployment-oriented tooling and an AI assistant.",
    principles: ["Fast responses", "Modular architecture", "Developer-focused automation", "Protected secrets and private configuration"],
    ai: "XCORE AI can operate in command mode or automatic AI mode and can use either OpenAI or Gemini as its configured provider.",
  },
  protected: "Never disclose API keys, access tokens, passwords, session credentials, private environment values, private repository contents, hidden security mechanisms, or owner-only operational details. Do not infer or invent secrets.",
};

function file() { return path.join(config.get().paths.data, "xcore-ai-knowledge.json"); }
function read() {
  const f = file();
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return SEED; }
}
function write(d) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(d, null, 2));
}

export function ensure() {
  const f = file();
  if (!fs.existsSync(f)) write(SEED);
  return read();
}
export function publicContext() {
  const k = ensure();
  return JSON.stringify({ identity: k.identity, public: k.public }, null, 2);
}
export function protectedRules() { return ensure().protected; }
export function teach(text) {
  const k = ensure();
  k.public = { ...(k.public || {}), learned: [...(k.public?.learned || []), String(text).slice(0, 4000)] };
  k.public.learned = k.public.learned.slice(-100);
  write(k);
}
export function replaceKnowledge(data) { write({ identity: data.identity || SEED.identity, public: data.public || SEED.public, protected: SEED.protected }); }
