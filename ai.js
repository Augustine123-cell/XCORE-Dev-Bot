import * as ai from "../../ai/index.js";
import { CommandError, command, requireOwner } from "./registry.js";

command(["ai", "xcoreai"], async (ctx) => {
  const sub = String(ctx.args[0] || "").toLowerCase();
  if (!sub || sub === "help") {
    return ctx.reply([
      "╔══ XCORE® AI ══╗",
      "",
      "@ai on        Enable AI for this chat",
      "@ai off       Disable AI for this chat",
      "@ai status    Show AI status",
      "@ai provider  Show active provider",
      "@ai provider openai|gemini   Switch provider (owner)",
      "@ai teach <text>             Add approved knowledge (owner)",
      "@ai reset                    Clear AI memory for this chat",
      "",
      "XCORE AI responds automatically to questions, direct messages and XCORE mentions when AI mode is enabled.",
      "╚════════════════╝",
    ].join("\n"));
  }
  if (sub === "on") {
    ai.setEnabled(ctx.chat, true);
    return ctx.reply("🤖 XCORE AI → ON\nAI will answer relevant messages in this chat.");
  }
  if (sub === "off") {
    ai.setEnabled(ctx.chat, false);
    return ctx.reply("🤖 XCORE AI → OFF");
  }
  if (sub === "status") {
    const s = ai.status();
    return ctx.reply(`🤖 XCORE AI\nMode: ${ai.enabled(ctx.chat) ? "ON" : "OFF"}\nProvider: ${s.provider}\nModel: ${s.model}\nWeb search: ${s.webSearch ? "ON" : "OFF"}\nOpenAI: ${s.openaiConfigured ? "configured" : "not configured"}\nGemini: ${s.geminiConfigured ? "configured" : "not configured"}`);
  }
  if (sub === "reset") {
    // Conversation memory is intentionally process-local; restarting also clears it.
    ai.clearMemory(ctx.chat);
    return ctx.reply("🧠 XCORE AI conversation memory cleared for this chat.");
  }
  if (sub === "teach") {
    requireOwner(ctx);
    const text = ctx.args.slice(1).join(" ").trim();
    if (!text) throw new CommandError("Usage: @ai teach <approved public knowledge>");
    ai.teach(text);
    return ctx.reply("🧠 XCORE AI knowledge base updated.");
  }
  if (sub === "model") {
    return ctx.reply(`Provider: ${ai.status().provider}\nModel: ${ai.status().model}`);
  }
  if (sub === "provider") {
    requireOwner(ctx);
    const p = String(ctx.args[1] || "").toLowerCase();
    if (!p || !["openai", "gemini"].includes(p)) throw new CommandError("Usage: @ai provider openai|gemini");
    ai.setProvider(p);
    return ctx.reply(`✅ XCORE AI provider switched to ${p.toUpperCase()}.`);
  }
  if (sub === "set") {
    requireOwner(ctx);
    const p = String(ctx.args[1] || "").toLowerCase();
    if (!p || !["openai", "gemini"].includes(p)) throw new CommandError("Usage: @ai set openai|gemini");
    ai.setProvider(p);
    return ctx.reply(`✅ XCORE AI provider switched to ${p.toUpperCase()}.`);
  }
  throw new CommandError("Unknown AI option. Use @ai help.");
});
