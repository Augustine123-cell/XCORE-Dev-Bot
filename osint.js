/** OSINT commands. Premium-gated by the handler; provider-backed ones fail closed until configured. */
import * as tgage from "../../osint/tgage.js";
import { CommandError, command } from "./registry.js";
import { prettyJson } from "./general.js";

command(["agecheck"], async (ctx) => {
  if (!ctx.args.length) throw new CommandError("Usage: ®agecheck <id>");
  await ctx.reply(prettyJson(await tgage.age(ctx.args[0])));
});

command(["tgage"], async (ctx) => {
  if (!ctx.args.length) throw new CommandError("Usage: ®tgage <id>");
  await ctx.reply(prettyJson(await tgage.age(ctx.args[0])));
});

const stat = (name, text) => command([name], async (ctx) => ctx.reply(text));

stat("wafind", "🔎 WA FIND is disabled until an authorized provider is configured.");
stat("getwadetail", "ℹ️ WhatsApp detail lookup requires a configured authorized provider.");
stat("getgcdetail", "ℹ️ Group detail uses only data available to the connected session.");
stat("tgfind", "🔎 Telegram search provider is not configured.");
stat("tgdetail", "ℹ️ Telegram profile lookup requires an authorized provider.");
stat("tggcdetail", "ℹ️ Telegram group/channel lookup requires an authorized provider.");
