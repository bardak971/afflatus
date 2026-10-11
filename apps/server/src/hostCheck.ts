import { environment } from "./config";
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
export function allowedHosts(env: NodeJS.ProcessEnv = environment()): Set<string> {
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

/** An asset's file or thumbnail: what another site's page may show in an img, video or audio element. */
const MEDIA_FILE = /^\/api\/assets\/[^/]+\/(file|thumb)$/;
const MEDIA_DEST = new Set(["image", "video", "audio"]);

/**
 * Whether a read (GET, HEAD) is another site's page making the browser of someone who has Afflatus open
 * fetch from it. The page cannot see the answer, but the server still does the work: a backup, a scan,
 * a whole library read, as often as the page likes. Refused, except a top-level navigation (a link
 * followed, a URL typed: the user sees where they went) and a picture, video or sound of an asset that
 * a page shows. Only Sec-Fetch-Site is read: a client that does not send it (curl, ComfyUI-Manager
 * fetching a download, a probe) is no browser's page, and the app's own requests are same-origin.
 * "same-site" is another site too, as for the changes (crossSite): a page on another port of the same
 * host, such as ComfyUI's own, where any custom node's script runs.
 */
export function crossSiteRead(headers: { "sec-fetch-site"?: string | string[]; "sec-fetch-mode"?: string | string[]; "sec-fetch-dest"?: string | string[] }, path: string): boolean {
  const site = headers["sec-fetch-site"];
  if (site !== "cross-site" && site !== "same-site") return false;
  const dest = headers["sec-fetch-dest"];
  // a frame is a navigation too, but not a top-level one: the headers below keep it from showing, not from running
  if (headers["sec-fetch-mode"] === "navigate" && (dest === undefined || dest === "document")) return false;
  return !(typeof dest === "string" && MEDIA_DEST.has(dest) && MEDIA_FILE.test(path));
}

/**
 * Sent with every answer. No page may show Afflatus in a frame (a click there is a same-origin click,
 * which the checks above take for the user's own); a file is read only as the type it is sent as;
 * no address of the app goes to another site with a link followed from it. No script policy: the
 * page and its workers are the server's own, and one would only risk breaking them.
 */
export const SAFETY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

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
