import { isIP } from "node:net";
import { httpError } from "./errors";

/**
 * Where the server may fetch from on a user's say-so: a model file's address, a link to resolve. The
 * server itself can reach what a browser on the LAN cannot (the router's page, a database with no
 * password, the cloud's metadata address), so an address that points inside the network is refused,
 * unless it is one of the few the server is meant to talk to (ComfyUI, a pretend Civitai in the tests).
 * The address as written is judged, and each address a redirect sends on to (fetchPublic): a public name
 * that resolves to a private address is not caught.
 */

/** Whether an IP address literal is one of the machine's own, of the LAN, or of the link (RFC 1918, loopback, link-local, and their IPv6 kin). */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) {
    const low = ip.toLowerCase();
    if (low === "::" || low === "::1") return true;
    // an IPv4 address carried in IPv6 is judged as the IPv4 address
    const mapped = /^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return isPrivateAddress(mapped[1]!);
    const head = parseInt(low.split(":")[0] || "0", 16);
    // fe80::/10 is the link, fc00::/7 is private
    return (head & 0xffc0) === 0xfe80 || (head & 0xfe00) === 0xfc00;
  }
  return false;
}

/** The host of an address, as a host alone: no port, no brackets. */
export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Whether a host names this machine or one of its network: a loopback or private literal, "localhost" and names under it, or a bare name with no dot (one of the LAN's). */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".arpa")) return true;
  if (isIP(h)) return isPrivateAddress(h);
  return !h.includes(".");
}

/**
 * Refuse an address the server should not fetch on a user's behalf: one that is not http or https, or
 * one that points at this machine or its network. `allow` lists hosts that are fine anyway (ComfyUI's).
 */
export function assertPublicUrl(url: string, allow: Array<string | null | undefined> = []): URL {
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    throw httpError("That is not an address.");
  }
  if (at.protocol !== "http:" && at.protocol !== "https:") throw httpError("Only http and https addresses are fetched.");
  const host = at.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = new Set(allow.filter((h): h is string => Boolean(h)).map((h) => h.replace(/^\[|\]$/g, "").toLowerCase()));
  if (!allowed.has(host) && isPrivateHost(host)) {
    throw httpError(`Afflatus does not fetch from addresses inside your own network (${at.hostname}): only from the internet.`);
  }
  return at;
}

/** The headers that may go on to another host than the one first asked: none that carries a key. */
const PLAIN = new Set(["user-agent", "accept"]);

/**
 * fetch() for an address already judged by assertPublicUrl: redirects are followed here, at most `hops`
 * of them, each new address judged the same way (a public link may send on into the network, or to the
 * cloud's metadata address). The headers given (a Civitai key) go to the host first asked only. `seen` hears
 * of each answer that sends on, before its body is let go: Hugging Face says a file's size and SHA-256 there only.
 */
export async function fetchPublic(url: string, init: Omit<RequestInit, "redirect" | "headers"> & { headers?: Record<string, string> }, allow: Array<string | null | undefined> = [], hops = 5, seen?: (res: Response) => void): Promise<Response> {
  const first = new URL(url).host;
  const all = init.headers ?? {};
  const plain = Object.fromEntries(Object.entries(all).filter(([k]) => PLAIN.has(k.toLowerCase())));
  let at = url;
  for (let n = 0; ; n++) {
    const res = await fetch(at, { ...init, headers: new URL(at).host === first ? all : plain, redirect: "manual" });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!next) return res;
    seen?.(res);
    await res.body?.cancel().catch(() => {});
    if (n >= hops) throw httpError(`${new URL(url).hostname} sent the request on more than ${hops} times.`, 502);
    at = assertPublicUrl(new URL(next, at).href, allow).href;
  }
}
