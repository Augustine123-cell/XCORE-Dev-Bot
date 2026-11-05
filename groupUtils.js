/** Defensive helpers for group metadata (Baileys shape, plus the dict shapes used by the original tests). */
import { normJid } from "./context.js";

export function value(obj, ...names) {
  if (obj === null || obj === undefined) return undefined;
  for (const name of names) {
    const found = obj[name];
    if (found !== undefined && found !== null) return found;
  }
  return undefined;
}

export function jidText(jid) {
  if (jid === null || jid === undefined) return "";
  if (typeof jid === "string") return jid;
  const user = value(jid, "User", "user");
  const server = value(jid, "Server", "server");
  if (user !== undefined) return `${user}@${server || "s.whatsapp.net"}`;
  return String(jid);
}

export const numberFromJid = (jid) => jidText(jid).split("@")[0].split(":")[0].replace(/\D/g, "");

export function participants(info) {
  const result = value(info, "participants", "Participants", "members", "Members");
  return Array.isArray(result) ? [...result] : [];
}

/** Prefer the phone-number JID: in LID-addressed groups `id` is an anonymous id and `phoneNumber` is the real one. */
export const participantJid = (p) => normJid(jidText(value(p, "phoneNumber", "PhoneNumber", "JID", "Jid", "jid", "id", "ID", "Id") ?? ""));

const role = (p) => String(value(p, "admin", "Admin", "role", "Role") ?? "").toLowerCase();

export function isAdmin(p) {
  const flag = value(p, "IsAdmin", "is_admin", "admin", "Admin");
  return Boolean(flag) || ["admin", "superadmin", "super_admin", "creator"].includes(role(p));
}

export function isSuperadmin(p) {
  const flag = value(p, "IsSuperAdmin", "is_super_admin", "SuperAdmin", "superadmin");
  return Boolean(flag) || ["superadmin", "super_admin", "creator"].includes(role(p));
}

export function findParticipant(info, number) {
  const clean = String(number ?? "").replace(/\D/g, "");
  return participants(info).find((p) => numberFromJid(participantJid(p)) === clean) ?? null;
}

export const groupSubject = (info) => String(value(info, "subject", "Subject", "GroupName", "Name", "name") ?? "Group") || "Group";
