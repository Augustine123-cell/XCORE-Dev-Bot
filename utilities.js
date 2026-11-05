/** Safe utility commands for XCORE: repository clone, MediaFire, contacts and QR. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as config from "../../config.js";
import { footer } from "../../format.js";
import * as http from "../../http.js";
import { UrlBlocked, assertSafeUrl } from "../../urlguard.js";
import { CommandError, command, requireSudo } from "./registry.js";

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
export const GIT_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

const cleanTag = (value) => value.replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 48) || "XCORE CONTACT";
const numberOf = (value) => String(value ?? "").replace(/\D/g, "");

function which(cmd) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

async function guard(url) {
  try {
    return await assertSafeUrl(url);
  } catch (exc) {
    if (exc instanceof UrlBlocked) throw new CommandError(exc.message);
    throw exc;
  }
}

command(["gitclone"], async (ctx) => {
  requireSudo(ctx);
  if (!ctx.args.length) throw new CommandError("Usage: ®gitclone <https://github.com/owner/repository>");
  const url = ctx.args[0].trim();
  const parts = await guard(url);
  if (!GIT_HOSTS.has(parts.hostname.toLowerCase()) || parts.protocol !== "https:") {
    throw new CommandError("Only public HTTPS repositories on GitHub, GitLab or Bitbucket are supported.");
  }
  if (!which("git")) throw new CommandError("Git is not installed on this host. Add Git to the deployment image and redeploy.");
  const targetRoot = path.join(config.get().paths.data, "cloned_repositories");
  fs.mkdirSync(targetRoot, { recursive: true });
  const slug =
    parts.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(-70) || "repository";
  const target = path.join(targetRoot, slug);
  if (fs.existsSync(target)) throw new CommandError(`A clone named '${slug}' already exists at ${target}. Remove it before cloning again.`);
  // No shell, no submodules, no hooks, no execution: this only downloads source files.
  const proc = spawn("git", ["clone", "--depth", "1", "--no-recurse-submodules", "--", url, target], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve("timeout"); }, 120_000);
    proc.on("close", (c) => { clearTimeout(timer); resolve(c); });
    proc.on("error", (e) => { clearTimeout(timer); stderr += e.message; resolve(1); });
  });
  if (code === "timeout") {
    fs.rmSync(target, { recursive: true, force: true });
    throw new CommandError("Git clone timed out after 120 seconds.");
  }
  if (code !== 0) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new CommandError(`Git clone failed: ${stderr.slice(-500)}`);
  }
  await ctx.reply(`✅ REPOSITORY CLONED\nRepository: ${slug}\nLocation: ${target}\nSource code was downloaded only; XCORE did not execute it.${footer(ctx.senderNumber)}`);
});

async function mediafireDirectUrl(pageUrl) {
  const parts = await guard(pageUrl);
  if (!["mediafire.com", "www.mediafire.com"].includes(parts.hostname)) throw new CommandError("Only public mediafire.com file links are supported.");
  const res = await http.request("GET", pageUrl, { headers: { "User-Agent": "Mozilla/5.0 XCORE/1.0" }, timeoutMs: 25_000, redirect: "manual" });
  let direct = "";
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    direct = new URL(res.headers.get("location") ?? "", pageUrl).toString();
  } else {
    const html = (await res.text()).slice(0, 2_000_000);
    const m = html.match(/href=["']([^"']+)["'][^>]*id=["']downloadButton["']|id=["']downloadButton["'][^>]*href=["']([^"']+)/i);
    direct = m ? m[1] || m[2] || "" : "";
  }
  if (!direct) throw new CommandError("Could not resolve a direct MediaFire download. The file may be private, removed or protected by a challenge.");
  try {
    await assertSafeUrl(direct);
  } catch (exc) {
    if (exc instanceof UrlBlocked) throw new CommandError(`MediaFire download blocked: ${exc.message}`);
    throw exc;
  }
  return direct;
}

command(["mediafire"], async (ctx) => {
  requireSudo(ctx);
  if (!ctx.args.length) throw new CommandError("Usage: ®mediafire <public MediaFire download link>");
  const direct = await mediafireDirectUrl(ctx.args[0]);
  const downloadDir = path.join(config.get().paths.data, "downloads");
  fs.mkdirSync(downloadDir, { recursive: true });
  const name = (path.basename(new URL(direct).pathname) || "mediafire_download.bin").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  const target = path.join(downloadDir, name);
  const res = await http.request("GET", direct, { timeoutMs: 60_000, redirect: "manual" });
  if (res.status < 200 || res.status >= 300) throw new CommandError(`Download failed: HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length") || 0);
  if (length > MAX_MEDIA_BYTES) throw new CommandError("Download exceeds the 50 MB safety limit.");
  let total = 0;
  const fd = fs.openSync(target, "w");
  try {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_MEDIA_BYTES) {
        fs.closeSync(fd);
        fs.rmSync(target, { force: true });
        throw new CommandError("Download exceeded the 50 MB safety limit.");
      }
      fs.writeSync(fd, chunk);
    }
    fs.closeSync(fd);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    throw e;
  }
  let status;
  if (typeof ctx.session.sendFile === "function") {
    await ctx.session.sendFile(ctx.chat, target, `Downloaded by 𝚇𝙲𝙾𝚁𝙴®: ${name}`);
    status = "Downloaded and sent to this chat.";
  } else {
    status = "Downloaded to the bot host; this WhatsApp library adapter does not expose file sending.";
  }
  await ctx.reply(`✅ MEDIAFIRE DOWNLOAD\nFile: ${name}\nSize: ${(total / 1024 / 1024).toFixed(2)} MB\n${status}\nPath: ${target}${footer(ctx.senderNumber)}`);
});

command(["save"], async (ctx) => {
  const args = [...ctx.args];
  if (!args.length || args[0].toLowerCase() !== "contact") throw new CommandError("Usage: ®save contact <tag> <target-number> (or reply to a user)");
  args.shift();
  const quoted = ctx.msg.quotedParticipant;
  let number, tag;
  if (quoted) {
    number = numberOf(quoted.split("@")[0].split(":")[0]);
    tag = cleanTag(args.join(" ") || "XCORE CONTACT");
  } else {
    if (args.length < 2) throw new CommandError("Usage: ®save contact <tag> <target-number>");
    number = numberOf(args[args.length - 1]);
    tag = cleanTag(args.slice(0, -1).join(" "));
  }
  if (number.length < 7 || number.length > 15) throw new CommandError("Target must be an international phone number (7–15 digits).");
  const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${tag}\nTEL;TYPE=CELL:+${number}\nEND:VCARD`;
  const fallback = (why) => ctx.reply(`CONTACT CARD\n${vcard}\n\n${why}${footer(ctx.senderNumber)}`);
  if (typeof ctx.session.sendContact !== "function") return fallback("Save these details to your address book manually.");
  try {
    await ctx.session.sendContact(ctx.chat, tag, number);
  } catch {
    return fallback("Native contact-card sending was unavailable; save these details to your address book manually.");
  }
  await ctx.reply(`✅ A WhatsApp contact card was sent.${footer(ctx.senderNumber)}`);
});

/** Decode QR codes from image bytes (jimp + jsqr, both pure JavaScript). */
export async function decodeQr(buffer) {
  let Jimp, jsQR;
  try {
    ({ Jimp } = await import("jimp"));
    jsQR = (await import("jsqr")).default;
  } catch {
    throw new CommandError("QR decoder dependencies are missing. Run `npm install` (jimp and jsqr), then restart.");
  }
  const image = await Jimp.read(buffer);
  const { data, width, height } = image.bitmap;
  const code = jsQR(new Uint8ClampedArray(data), width, height, { inversionAttempts: "attemptBoth" });
  return code && code.data ? [code.data] : [];
}

command(["readqr"], async (ctx) => {
  // QR decoding is limited to an image attached/replied to in the same chat.
  if (typeof ctx.session.downloadMedia !== "function") {
    throw new CommandError("This WhatsApp adapter does not expose image downloading yet. Reply to an image after enabling media download support.");
  }
  let data;
  try {
    data = await ctx.session.downloadMedia(ctx.msg.raw);
    if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) throw new Error("Image bytes were not returned");
  } catch (exc) {
    throw new CommandError(`Could not download the replied image: ${String(exc.message ?? exc).slice(0, 160)}`);
  }
  let values;
  try {
    values = await decodeQr(Buffer.from(data));
  } catch (exc) {
    if (exc instanceof CommandError) throw exc;
    throw new CommandError(`Could not decode the image: ${String(exc.message ?? exc).slice(0, 160)}`);
  }
  if (!values.length) throw new CommandError("No readable QR code was found in the replied image.");
  // Display decoded text only. Never open URLs or run QR contents.
  const output = values.slice(0, 5).map((v, i) => `${i + 1}. ${v.slice(0, 1200)}`).join("\n\n");
  const label = ctx.args.join(" ").trim().slice(0, 60);
  const labelLine = label ? `Tag: ${label}\n` : "";
  await ctx.reply(`🔎 QR SCAN RESULT\n${labelLine}${output}\n\nDecoded content is shown as text only; XCORE did not open any links.${footer(ctx.senderNumber)}`);
});
