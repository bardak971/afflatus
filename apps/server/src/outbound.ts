import dns, { type LookupAddress, type LookupOptions } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as fetchVia } from "undici";
import { httpError } from "./errors";

/**
 * Where the server may fetch from on a user's say-so: a model file's address, a link to resolve. The
 * server itself can reach what a browser on the LAN cannot (the router's page, a database with no
 * password, the cloud's metadata address), so an address that points inside the network is refused,
 * unless it is one of the few the server is meant to talk to (a pretend Civitai in the tests and the demo),
 * named by host and port: another port of the same machine is another service. The address as written is
 * judged, and each address a redirect sends on to (fetchPublic); and a name is judged again by the addresses
 * it resolves to when the connection is made, so that a public name that points inside the network (or is
 * made to between the check and the connection) is refused too.
 */

/** An IPv4 address as its four bytes, or null when it is not one. */
function v4Bytes(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split(".").map(Number);
}

/** An IPv6 address as its eight 16-bit groups, an IPv4 tail ("::ffff:1.2.3.4") and "::" spelled out; null when it is not one. */
function v6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let text = ip.toLowerCase().replace(/%.*$/, "");
  // an IPv4 tail is two groups written the other way
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a = 0, b = 0, c = 0, d = 0] = v4Bytes(tail[1]!) ?? [];
    text = `${text.slice(0, -tail[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest === undefined ? [] : rest ? rest.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (rest === undefined && missing !== 0) return null;
  return [...left, ...Array<string>(rest === undefined ? 0 : missing).fill("0"), ...right].map((g) => parseInt(g, 16));
}

/** Whether an IPv4 address is one the internet does not route to a stranger's server: this machine, the LAN, the link, a carrier's NAT, the benchmark range, multicast and above. */
function privateV4([a = 0, b = 0]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/**
 * Whether an IP address literal is one of the machine's own, of the LAN, or of the link (RFC 1918, loopback,
 * link-local, and their IPv6 kin). An IPv6 address that carries an IPv4 one (mapped ::ffff:0:0/96, the old
 * compatible ::/96, NAT64's 64:ff9b::/96, 6to4's 2002::/16) is judged by the IPv4 address it carries, whichever
 * way it is written: "::ffff:127.0.0.1" and "::ffff:7f00:1" are the same address.
 */
export function isPrivateAddress(ip: string): boolean {
  const four = v4Bytes(ip);
  if (four) return privateV4(four);
  const g = v6Groups(ip);
  if (!g) return false;
  const carried = (hi: number, lo: number) => privateV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::/96 (with :: and ::1 in it), ::ffff:0:0/96 and ::ffff:0:0:0/96
  if (zeros(6) || (zeros(5) && g[5] === 0xffff) || (zeros(4) && g[4] === 0xffff && g[5] === 0)) return zeros(7) ? true : carried(g[6]!, g[7]!);
  // NAT64, the well-known prefix and the local one (64:ff9b:1::/48 is a network's own)
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 1 || carried(g[6]!, g[7]!);
  if (g[0] === 0x2002) return carried(g[1]!, g[2]!);
  // fe80::/10 is the link, fec0::/10 the old site-local, fc00::/7 private, ff00::/8 multicast
  return (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xffc0) === 0xfec0 || (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xff00) === 0xff00;
}

/** The host and port of an address ("127.0.0.1:8188"), the port said even when it is the scheme's own; null for what is not an address. */
export function hostPortOf(url: string): string | null {
  try {
    const at = new URL(url);
    if (at.protocol !== "http:" && at.protocol !== "https:") return null;
    return `${at.hostname.toLowerCase()}:${at.port || (at.protocol === "https:" ? "443" : "80")}`;
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
 * one that points at this machine or its network. `allow` lists addresses that are fine anyway (a pretend
 * Civitai's), each by its host and its port: allowing one service of a machine allows none of its others.
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
  const allowed = new Set(allow.map((a) => (a ? hostPortOf(a) : null)).filter(Boolean));
  if (!allowed.has(hostPortOf(at.href)) && isPrivateHost(host)) {
    throw httpError(`Afflatus does not fetch from addresses inside your own network (${at.host}): only from the internet.`);
  }
  return at;
}

/** What a connection refused by its resolved address throws, told apart from a host that cannot be reached. */
class InsideNetwork extends Error {
  readonly code = "EINSIDE";
}

/**
 * dns.lookup for the connections fetchPublic makes: the name is resolved, and when any of its addresses is
 * inside the network the connection is not made. Judging the address actually connected to is what catches a
 * public name that points inside (localtest.me is 127.0.0.1) or is made to point there after it was checked.
 */
export function insideRefusingLookup(hostname: string, options: LookupOptions, done: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  dns.lookup(hostname, { ...options, all: true }, (err, found) => {
    if (err) return done(err, []);
    const inside = found.find((f) => isPrivateAddress(f.address));
    if (inside) return done(new InsideNetwork(`Afflatus does not fetch from addresses inside your own network (${hostname} is ${inside.address}): only from the internet.`), []);
    if (options.all) return done(null, found);
    if (!found[0]) return done(Object.assign(new Error(`${hostname} has no address`), { code: "ENOTFOUND" }), []);
    done(null, found[0].address, found[0].family);
  });
}

/** The connections fetchPublic makes to an address not named as allowed: each one checked where it lands. */
let guarded: Agent | null = null;
const guard = () => (guarded ??= new Agent({ connect: { lookup: insideRefusingLookup } }));

/**
 * A fetch through the guarded agent. Node's own fetch runs the undici built into Node: from Node 24 the same major as the
 * agent's, which it drives; Node 22 (the engines allow 22.16) has an older one that cannot, so there undici's own fetch
 * goes with its agent. The answer is a web Response either way.
 */
const SAME_UNDICI = Number((process.versions as Record<string, string | undefined>).undici?.split(".")[0]) >= 7;
function guardedFetch(url: string, init: RequestInit): Promise<Response> {
  if (SAME_UNDICI) return fetch(url, { ...init, dispatcher: guard() } as RequestInit);
  return fetchVia(url, { ...init, dispatcher: guard() } as Parameters<typeof fetchVia>[1]) as unknown as Promise<Response>;
}

/** The refusal of insideRefusingLookup in a failed fetch(), which undici keeps in the error's cause. */
function insideOf(err: unknown): InsideNetwork | null {
  for (let e = err as { cause?: unknown } | undefined, n = 0; e && n < 4; e = e.cause as typeof e, n++) if (e instanceof InsideNetwork) return e;
  return null;
}

/** The headers that may go on to another host than the one first asked: none that carries a key. */
const PLAIN = new Set(["user-agent", "accept"]);

/**
 * fetch() for an address already judged by assertPublicUrl: redirects are followed here, at most `hops`
 * of them, each new address judged the same way (a public link may send on into the network, or to the
 * cloud's metadata address), and never from https down to http. The headers given (a Civitai key) go to the
 * host first asked only. `seen` hears of each answer that sends on, before its body is let go: Hugging Face says
 * a file's size and SHA-256 there only.
 */
export async function fetchPublic(url: string, init: Omit<RequestInit, "redirect" | "headers"> & { headers?: Record<string, string> }, allow: Array<string | null | undefined> = [], hops = 5, seen?: (res: Response) => void): Promise<Response> {
  const first = new URL(url).host;
  const all = init.headers ?? {};
  const plain = Object.fromEntries(Object.entries(all).filter(([k]) => PLAIN.has(k.toLowerCase())));
  const allowed = new Set(allow.map((a) => (a ? hostPortOf(a) : null)).filter(Boolean));
  let at = url;
  for (let n = 0; ; n++) {
    // an address named as allowed is the one place inside the network it may reach; any other is judged again where it connects
    const init_ = { ...init, headers: new URL(at).host === first ? all : plain, redirect: "manual" } as RequestInit;
    const sent = allowed.has(hostPortOf(at)) ? fetch(at, init_) : guardedFetch(at, init_);
    const res = await sent.catch((err: unknown) => {
      const inside = insideOf(err);
      throw inside ? httpError(inside.message) : err;
    });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!next) return res;
    seen?.(res);
    await res.body?.cancel().catch(() => {});
    if (n >= hops) throw httpError(`${new URL(url).hostname} sent the request on more than ${hops} times.`, 502);
    const to = assertPublicUrl(new URL(next, at).href, allow);
    // what was asked over https is not let down to plain http on the way: anyone on the path could answer it
    if (new URL(at).protocol === "https:" && to.protocol === "http:") throw httpError(`${new URL(at).hostname} sent the request on to a plain http address (${to.host}): refused.`, 502);
    at = to.href;
  }
}

/** The error codes that say a host could not be reached at all, where trying again a moment later changes nothing. */
const UNREACHABLE = /^(ECONNREFUSED|ENOTFOUND|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_TLS_CERT)/;

/** The code of a failed fetch() (undici says "fetch failed" and keeps the reason in its cause): ECONNREFUSED, ENOTFOUND, a certificate's. */
export function failCode(err: unknown): string | null {
  for (let e = err as { code?: unknown; cause?: unknown; errors?: unknown[] } | undefined, n = 0; e && n < 4; e = e.cause as typeof e, n++) {
    if (typeof e.code === "string") return e.code;
    // a name with several addresses: each one refused, said together
    const first = Array.isArray(e.errors) ? (e.errors[0] as { code?: unknown } | undefined) : undefined;
    if (typeof first?.code === "string") return first.code;
  }
  return null;
}

/** Whether a failed fetch() means its host cannot be reached (refused, unknown, a bad certificate), not a connection cut. */
export const cannotReach = (err: unknown) => UNREACHABLE.test(failCode(err) ?? "");

/** A failed fetch() said plainly: "could not reach civitai.com (ENOTFOUND)" rather than undici's bare "fetch failed". */
export function fetchFailure(err: unknown, url: string): string {
  const said = (err as Error).message ?? String(err);
  if (!/fetch failed/i.test(said)) return said;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // not an address: said as it was given
  }
  const code = failCode(err);
  return `could not reach ${host}${code ? ` (${code})` : ""}`;
}
