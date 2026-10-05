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
