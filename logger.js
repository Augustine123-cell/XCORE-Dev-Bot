/** Tiny console logger matching the original bot's output style. */
import util from "node:util";

function ts() {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS (UTC)
}

function fmt(args) {
  return args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message || String(a) : util.inspect(a, { depth: 3 })))
    .join(" ");
}

function out(sym, args, err = false) {
  const line = `[${ts()}] ${sym} ${fmt(args)}`;
  (err ? console.error : console.log)(line);
}

export const info = (...a) => out("▸", a);
export const ok = (...a) => out("✓", a);
export const warn = (...a) => out("⚠", a, true);
export const error = (...a) => out("✗", a, true);
export const dim = (...a) => out(" ", a);
