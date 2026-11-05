/** Command registry. Each command is `async (ctx) => {}`, registered with command(["name", …], handler). */
export const REGISTRY = new Map();

/** A user-facing failure; the handler replies with '❌ <message>'. */
export class CommandError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandError";
  }
}

export function command(names, fn) {
  for (const n of Array.isArray(names) ? names : [names]) REGISTRY.set(n, fn);
  return fn;
}

export function requireOwner(ctx) {
  if (!ctx.isOwner) throw new CommandError("Owner-only command.");
}

export function requireSudo(ctx) {
  if (!(ctx.isOwner || ctx.isSudo)) throw new CommandError("Sudo-only command.");
}
