/**
 * Whether an address is out on the internet over plain http: anyone who finds it could run code on that ComfyUI. Loopback,
 * the private ranges, Tailscale's (100.64/10, and its fd7a: IPv6), link-local and .local names are not. The IPv6 ranges
 * (fc00::/7, fe80::/10) are read on IPv6 literals only: a name such as fdgpu.example.com is out on the internet.
 */
export function publicPlainHttp(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host.includes(":")) return publicIpv6(host);
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal")) return false;
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  // a name without a dot is a machine of the network (a hosts file's, the router's)
  if (!ip) return host.includes(".");
  return publicIpv4(Number(ip[1]), Number(ip[2]));
}

const publicIpv4 = (a: number, b: number) =>
  !(a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254));

/** An IPv6 literal as the URL writes it (lower case, shortest form): loopback, unique-local, link-local and IPv4-mapped private ones are not public. */
function publicIpv6(host: string): boolean {
  if (host === "::1" || host === "::") return false;
  // fc00::/7 (unique local, Tailscale's fd7a: among them) and fe80::/10 (link-local); a first group of four digits, as
  // fc::1 is 00fc::1, out on the internet
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return false;
  // an IPv4 address written as IPv6 (::ffff:10.0.0.5, which the URL writes ::ffff:a00:5): as that IPv4 address
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16);
    return publicIpv4(high >> 8, high & 0xff);
  }
  return true;
}
