/** SSRF guard: only public http(s) targets, no embedded credentials, no private IPs. */
import dns from "node:dns/promises";
import net from "node:net";

export class UrlBlocked extends Error {
  constructor(message) {
    super(message);
    this.name = "UrlBlocked";
  }
}

/** Tests replace `resolver.lookup` so no real DNS is needed. */
export const resolver = {
  lookup: (host) => dns.lookup(host, { all: true }),
};

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, p) => acc * 256 + Number(p), 0);
}

const V4_BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => ({ base: ipv4ToInt(base), bits }));

function v4Private(ip) {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(({ base, bits }) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

/** Expand an IPv6 literal into eight 16-bit groups (handles :: and an embedded IPv4 tail). */
function v6Groups(ip) {
  let s = ip.split("%")[0].toLowerCase();
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const n = ipv4ToInt(tail[1]);
    s = s.slice(0, -tail[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const fill = rest === undefined ? [] : Array(8 - h.length - r.length).fill("0");
  return [...h, ...fill, ...r].map((x) => parseInt(x || "0", 16));
}

/** True for anything that is not a globally routable address (private, loopback, link-local, CGNAT, …). */
export function isPrivateIp(ip) {
  const kind = net.isIP(String(ip).split("%")[0]);
  if (kind === 4) return v4Private(ip);
  if (kind !== 6) return true; // unparseable → treat as unsafe
  const g = v6Groups(ip);
  if (g.length !== 8 || g.some(Number.isNaN)) return true;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    // IPv4-mapped (::ffff:a.b.c.d)
    return v4Private(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  if ((g[0] & 0xe000) !== 0x2000) return true; // only 2000::/3 is global unicast
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] < 0x0200)) return true; // documentation + IETF special-purpose
  return false;
}

/** Validate a user-supplied URL. Returns the parsed URL or throws UrlBlocked with a user-facing message. */
export async function assertSafeUrl(raw) {
  const text = String(raw).trim();
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) throw new UrlBlocked("Invalid URL.");
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new UrlBlocked("Invalid URL.");
  }
  const scheme = u.protocol.replace(/:$/, "");
  if (scheme !== "http" && scheme !== "https") throw new UrlBlocked("Only http:// and https:// URLs are allowed.");
  let host = u.hostname.toLowerCase();
  if (!host) throw new UrlBlocked("Invalid URL.");
  if (u.username || u.password) throw new UrlBlocked("URLs with embedded credentials are not allowed.");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new UrlBlocked("Local/private hosts are not allowed.");
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new UrlBlocked("Private/local IP addresses are not allowed.");
    return u;
  }
  let infos;
  try {
    infos = await resolver.lookup(host);
  } catch {
    throw new UrlBlocked("Host could not be resolved.");
  }
  if (!infos || !infos.length || infos.some((i) => isPrivateIp(i.address))) {
    throw new UrlBlocked("Host resolves to a private/local address and was blocked.");
  }
  return u;
}
