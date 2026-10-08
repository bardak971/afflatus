/**
 * Which names the server answers to. A page open in the browser on the same machine can point one of
 * its own names at 127.0.0.1 (DNS rebinding) and then drive the API from a script, since there is no
 * login; the Host header still carries that name, so a request whose Host is not one of the server's
 * own is refused. The server's own names: localhost and the loopback addresses, the address it was
 * bound to (HOST, when it is a real address rather than "every address"), the host of PUBLIC_URL, and
 * whatever ALLOWED_HOSTS adds (comma-separated: the machine's LAN address or name, a reverse proxy's name).
 */

const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];
const EVERY_ADDRESS = new Set(["", "0.0.0.0", "::", "[::]"]);

/** The host part of a Host header, lower-cased, without the port: "pc.lan:8720" → "pc.lan", "[::1]:8720" → "[::1]". */
export function hostOnly(header: string): string {
  const h = header.trim().toLowerCase();
  const bracketed = /^(\[[^\]]*\])(?::\d*)?$/.exec(h);
  if (bracketed) return bracketed[1]!;
  // one colon: a port follows; several: a bare IPv6 address
  return h.split(":").length === 2 ? h.slice(0, h.indexOf(":")) : h;
}

/** The names that are allowed, from the environment. */
export function allowedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set(LOOPBACK);
  const bound = (env.HOST ?? "").trim().toLowerCase();
  if (!EVERY_ADDRESS.has(bound)) hosts.add(bound.includes(":") && !bound.startsWith("[") ? `[${bound}]` : bound);
  const publicUrl = env.PUBLIC_URL?.trim();
  if (publicUrl) {
    try {
      hosts.add(new URL(publicUrl).hostname.toLowerCase().replace(/^(?!\[)(.*:.*)$/, "[$1]"));
    } catch {
      // not an address: nothing to allow from it
    }
  }
  for (const h of (env.ALLOWED_HOSTS ?? "").split(",")) {
    const one = hostOnly(h);
    if (one) hosts.add(one);
  }
  hosts.delete("");
  return hosts;
}

/** Whether a request with this Host header may be answered. No header (a plain HTTP/1.0 client, a test) is allowed. */
export function hostAllowed(header: string | undefined, allowed: Set<string>): boolean {
  if (header === undefined) return true;
  return allowed.has(hostOnly(header));
}

/** Read-only addresses a scraper or a probe asks for by a name of its own (a pod's address): answered to whatever the Host. */
export const ANY_HOST = new Set(["/metrics", "/api/health"]);

/**
 * Whether a request that changes something came from another site's page. The Host check does not see
 * this: a form or a no-cors fetch from any page carries this server's own Host. A browser says where
 * a request came from (Sec-Fetch-Site, Origin); a request with neither (curl, a script) is no page's.
 */
export function crossSite(headers: { origin?: string; "sec-fetch-site"?: string | string[] }, allowed: Set<string>): boolean {
  const site = headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return true;
  if (headers.origin === undefined) return false;
  try {
    return !allowed.has(hostOnly(new URL(headers.origin).host));
  } catch {
    // "null" (a sandboxed page, a file) or garbage: not one of ours
    return true;
  }
}

/** The body types the server reads: JSON, and a file sent as it is (app.ts's upload parser). */
export const UPLOAD_TYPE = /^(image|video|audio)\/|^application\/octet-stream$/;

/**
 * Whether a request that changes something says it is not a plain form's. A page elsewhere can send a
 * "simple" request (no body, or a text/plain or form body) without the browser asking first, and an
 * older browser sends neither Sec-Fetch-Site nor Origin with it. JSON, a file type, or the header
 * `X-Afflatus: 1` (the web app's own requests carry it) each need a preflight from another site.
 */
export function marked(headers: { "content-type"?: string; "x-afflatus"?: string | string[] }): boolean {
  if (headers["x-afflatus"] === "1") return true;
  const type = (headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  return type === "application/json" || UPLOAD_TYPE.test(type);
}
