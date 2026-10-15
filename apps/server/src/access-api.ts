import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Access, Granted } from "./access";
import { envSaid, loadConfig } from "./config";
import { httpError } from "./errors";
import { fromThisComputer } from "./hostCheck";
import type { Services } from "./services";

/**
 * The lock and its routes (access.ts): who a request is, the 401 for an API route without a session when a password is
 * set, and the sign-in, the reset codes, the password itself and the devices signed in (Settings › Interface › Access).
 */

declare module "fastify" {
  interface FastifyRequest {
    /** Who this request is, for the lock: set on every request by the hook below. */
    access: {
      /** A password is set. */
      locked: boolean;
      /** It comes from this computer (hostCheck.ts fromThisComputer). */
      local: boolean;
      /** It needs no session: no password, or this computer's while "From this computer" is in effect. */
      open: boolean;
      /** Its session's id, when its cookie names a good one. */
      session: string | null;
    };
  }
}

/**
 * The API routes open without a session, by method and route: the probe's health, the sign-in page's own (its state, the
 * sign-in, the sign-out, a reset code asked for and used), and the one-time address ComfyUI or a pod fetches a download
 * from, which carries a token of its own (downloads.ts). The rest of /api, the event stream included, is locked, and so is
 * /metrics, which a scraper reaches with the metrics token.
 */
const OPEN_ROUTES = new Set([
  "GET /api/health",
  "GET /api/session",
  "POST /api/session/sign-in",
  "POST /api/session/sign-out",
  "POST /api/session/forgot",
  "POST /api/session/reset",
  "GET /api/downloads/fetch/:id",
]);

/** Whether a request may go without a session: its route is one of the above (a HEAD as its GET). */
export function openRoute(method: string, route: string | undefined): boolean {
  return Boolean(route) && OPEN_ROUTES.has(`${method === "HEAD" ? "GET" : method} ${route}`);
}

/**
 * The most an open route takes as a body: a password and a few flags. Anyone may send to these, so a body is never read
 * past this (bodyLimit), and only as JSON: a file type would go to the upload parser, which writes up to 512 MB to disk.
 */
const OPEN_BODY = 16 * 1024;

/**
 * The cookies, named by the port: two Afflatus on one computer (another port, a demo beside the real one) are one site
 * to the browser, whose cookies do not tell ports apart: one name each, or a sign-in on one would sign out the other.
 */
export const cookieNames = (port: number) => ({ session: `afflatus_session_${port}`, device: `afflatus_device_${port}`, reset: `afflatus_reset_${port}` });

/** A request's cookies, by name; a value that does not decode is left out. */
export function cookiesOf(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    try {
      if (!(name in out)) out[name] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      // not ours: a cookie of another app on this host
    }
  }
  return out;
}

/**
 * How many times a cookie name comes in a Cookie header. Cookies do not tell ports apart: a page on another port of this
 * host (ComfyUI's, where any custom node's script runs) can plant one of the same name with a narrower Path, which the
 * browser then sends first. Two of the session's name are taken for none.
 */
export function cookieCount(header: string | undefined, name: string): number {
  return (header ?? "").split(";").filter((part) => part.slice(0, Math.max(0, part.indexOf("="))).trim() === name).length;
}

/**
 * One Set-Cookie: HttpOnly (no script of the page reads it), SameSite=Lax (another site's page does not send it with a
 * request of its own), Secure over https. No Max-Age: the browser's session.
 */
export function cookie(name: string, value: string, opts: { maxAgeS: number | null; secure: boolean; strict?: boolean; path?: string }): string {
  return [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? "/"}`, "HttpOnly", `SameSite=${opts.strict ? "Strict" : "Lax"}`, ...(opts.maxAgeS !== null ? [`Max-Age=${opts.maxAgeS}`] : []), ...(opts.secure ? ["Secure"] : [])].join("; ");
}

/**
 * Whether the browser reached Afflatus over https: the connection itself, the address it is published at (PUBLIC_URL),
 * or a proxy on this computer that says so (X-Forwarded-Proto believed only from loopback, where nobody else can send it).
 */
export function overHttps(req: Pick<FastifyRequest, "protocol" | "headers" | "socket">): boolean {
  if (req.protocol === "https") return true;
  if (/^https:\/\//i.test(envSaid.publicUrl()?.trim() ?? "")) return true;
  const ip = (req.socket.remoteAddress ?? "").toLowerCase();
  const loopback = /^127\./.test(ip) || ip === "::1" || /^::ffff:127\./.test(ip);
  return loopback && String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim().toLowerCase() === "https";
}

/** A device's own cookie lives as long as browsers allow (400 days): it is what tells a device seen before from a new one. */
const DEVICE_AGE_S = 400 * 86_400;
/** A reset code's browser cookie lives as long as the code. */
const RESET_AGE_S = 600;

const signInBody = z.object({ password: z.string().max(2000), remember: z.boolean().default(true) });
const forgotBody = z.object({ via: z.enum(["telegram", "computer"]) });
const resetBody = z.object({ code: z.string().max(20), password: z.string().max(2000), signOutOthers: z.boolean().default(true) });
const passwordBody = z.object({ current: z.string().max(2000).default(""), password: z.string().max(2000), signOutOthers: z.boolean().default(false) });
const offBody = z.object({ current: z.string().max(2000) });
const everywhereBody = z.object({ keepThis: z.boolean().default(false) });
const settingsBody = z.strictObject({
  current: z.string().max(2000).optional(),
  localNoPassword: z.boolean().optional(),
  stayDays: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).optional(),
  resetTelegram: z.boolean().optional(),
  newDevice: z.strictObject({ telegram: z.boolean().optional(), discord: z.boolean().optional() }).optional(),
});
const metricsBody = z.object({ make: z.boolean(), current: z.string().max(2000).optional() });

/** The lock's hook: registered right after the host and site checks (app.ts), before every route. */
export function registerAccessHook(app: FastifyInstance, access: Access): void {
  const names = cookieNames(loadConfig().port);
  app.decorateRequest("access", null as unknown as FastifyRequest["access"]);
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    const route = req.routeOptions.url;
    // the path as asked and the route it found are both looked at: a path the router decodes ("/%61pi/…") is still the API
    const api = path === "/api" || path.startsWith("/api/") || Boolean(route?.startsWith("/api/"));
    const metrics = path === "/metrics" || route === "/metrics";
    const local = fromThisComputer(req);
    const a = await access.settings();
    const locked = a.password !== null;
    const bypass = !locked || (local && access.bypassOn(a));
    const twice = cookieCount(req.headers.cookie, names.session) > 1;
    const session = locked && (api || metrics) && !twice ? ((await access.sessionOf(cookiesOf(req.headers.cookie)[names.session], req.socket.remoteAddress ?? ""))?.id ?? null) : null;
    req.access = { locked, local, open: bypass, session };
    const open = openRoute(req.method, route);
    const reads = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
    // locked, a change without a session is answered before its body is read, whatever the address
    if (locked && !bypass && !session && !open && !reads) {
      return reply.status(401).header("X-Afflatus-Sign-In", "1").send({ error: "Sign in first: this Afflatus has a password.", signIn: true });
    }
    // nothing matched: a 404 before any body is read (the upload parser would write it to disk first)
    if (!route && !reads) return reply.status(404).send({ error: "there is nothing at this address" });
    // a body sent to a route anyone may call is JSON or nothing (OPEN_BODY)
    if (open && req.method === "POST") {
      const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
      if (hasBody && type !== "application/json") return reply.status(415).send({ error: "These routes take JSON only." });
    }
    if (metrics) {
      if (bypass || session || (await access.metricsTokenOk(req.headers.authorization))) return;
      return reply.status(401).header("WWW-Authenticate", "Bearer").type("text/plain").send("Afflatus has a password: /metrics needs the metrics token (Settings › Interface › Access) as a Bearer token.\n");
    }
    if (!api || bypass || session || open) return;
    // the page reads this header (api.ts) to show the sign-in again: a 401 of its own (a wrong password) is not this
    return reply.status(401).header("X-Afflatus-Sign-In", "1").header("Cache-Control", "no-store").send({ error: "Sign in first: this Afflatus has a password.", signIn: true });
  });
}

export function registerAccess(app: FastifyInstance, s: Services): void {
  const access = s.access;
  const config = loadConfig();
  const names = cookieNames(config.port);
  const ip = (req: FastifyRequest) => req.socket.remoteAddress ?? "";
  const ua = (req: FastifyRequest) => String(req.headers["user-agent"] ?? "").slice(0, 400);
  const deviceOf = (req: FastifyRequest) => cookiesOf(req.headers.cookie)[names.device];
  const resetOf = (req: FastifyRequest) => (cookieCount(req.headers.cookie, names.reset) > 1 ? undefined : cookiesOf(req.headers.cookie)[names.reset]);
  const small = { bodyLimit: OPEN_BODY };

  /** The cookies of a session just given. */
  const give = (req: FastifyRequest, reply: FastifyReply, g: Granted, extra: string[] = []) => {
    reply.header("Set-Cookie", [
      cookie(names.session, g.token, { maxAgeS: g.maxAgeS, secure: overHttps(req) }),
      cookie(names.device, g.device, { maxAgeS: DEVICE_AGE_S, secure: overHttps(req) }),
      ...extra,
    ]);
  };
  /** The session's cookie taken off this browser (its device cookie stays: it is still a device seen before). */
  const clear = (req: FastifyRequest, reply: FastifyReply) => reply.header("Set-Cookie", cookie(names.session, "", { maxAgeS: 0, secure: overHttps(req) }));

  /**
   * What the page needs before anything else: is there a password, is this browser in, may a code go to Telegram. Whether
   * this computer is exempt is said only to a browser that is in: to anyone else it would say how to get in.
   */
  const state = async (req: FastifyRequest) => {
    const a = await access.settings();
    const ways = await access.resetWays();
    const signedIn = req.access.open || req.access.session !== null;
    return {
      locked: a.password !== null,
      signedIn,
      ...(signedIn ? { local: req.access.local, localNoPassword: access.bypassOn(a) } : {}),
      session: req.access.session !== null,
      stayDays: a.stayDays,
      telegram: a.password !== null && ways.telegram,
      // Telegram changed lately: the Forgot screen says when it is a way again
      telegramHeld: a.password !== null ? Math.ceil(ways.telegramHeld / 60_000) : 0,
      wait: Math.ceil(access.passwordTries.waitMs(ip(req)) / 1000),
      sendAgain: access.sendAgainS(ip(req)),
    };
  };
  app.get("/api/session", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return state(req);
  });

  app.post("/api/session/sign-in", small, async (req, reply) => {
    const b = signInBody.parse(req.body);
    const granted = await access.signIn({ password: b.password, remember: b.remember, ip: ip(req), ua: ua(req), device: deviceOf(req) });
    give(req, reply, granted);
    return { ok: true };
  });

  app.post("/api/session/sign-out", small, async (req, reply) => {
    await access.signOut(req.access.session);
    clear(req, reply);
    return { ok: true };
  });

  /** A code asked for: tied to this browser by a cookie of its own (access.ts forgot), which the reset needs with the code. */
  app.post("/api/session/forgot", small, async (req, reply) => {
    const sent = await access.forgot(forgotBody.parse(req.body).via, ip(req), resetOf(req));
    reply.header("Set-Cookie", cookie(names.reset, sent.nonce, { maxAgeS: RESET_AGE_S, secure: overHttps(req), strict: true, path: "/api/session" }));
    return { via: sent.via, again: sent.again };
  });

  app.post("/api/session/reset", small, async (req, reply) => {
    const b = resetBody.parse(req.body);
    const granted = await access.reset({ ...b, nonce: resetOf(req), ip: ip(req), ua: ua(req), device: deviceOf(req), session: req.access.session });
    give(req, reply, granted, [cookie(names.reset, "", { maxAgeS: 0, secure: overHttps(req), strict: true, path: "/api/session" })]);
    return { ok: true };
  });

  /** Settings › Access: where Afflatus listens, whether this computer may be exempt, the devices signed in, the last alarm. Behind the lock. */
  app.get("/api/session/devices", async (req) => {
    const bound = config.host;
    const everywhere = bound === "0.0.0.0" || bound === "::" || bound === "[::]";
    const loopback = /^127\./.test(bound) || bound === "::1" || bound === "localhost";
    const alarm = access.lastAlarm && Date.now() - access.lastAlarm.at < 86_400_000 ? { at: new Date(access.lastAlarm.at).toISOString(), said: access.lastAlarm.said } : null;
    return { listen: { host: bound, port: config.port, reach: loopback ? "computer" : everywhere ? "network" : "address" }, canBypass: access.bypassAllowed(), alarm, devices: await access.devices(req.access.session) };
  });

  app.post<{ Params: { id: string } }>("/api/session/devices/:id/sign-out", async (req, reply) => {
    await access.signOutDevice(req.params.id, ip(req));
    if (req.params.id === req.access.session) clear(req, reply);
    return { ok: true };
  });

  app.post("/api/session/sign-out-everywhere", async (req, reply) => {
    const { keepThis } = everywhereBody.parse(req.body ?? {});
    await access.signOutEverywhere(keepThis ? req.access.session : null, ip(req));
    if (!keepThis) clear(req, reply);
    return { ok: true };
  });

  /** Set the password, or change it (the current one with it). The device asking stays signed in. */
  app.post("/api/session/password", async (req, reply) => {
    const b = passwordBody.parse(req.body);
    const granted = await access.setPassword({ ...b, ip: ip(req), ua: ua(req), device: deviceOf(req), session: req.access.session, bypass: req.access.local && access.bypassOn(await access.settings()) });
    if (granted) give(req, reply, granted);
    return { ok: true };
  });

  /** Turn the password off (the current one with it): every session ends, Afflatus is open again. */
  app.post("/api/session/password/off", async (req, reply) => {
    if (!req.access.locked) throw httpError("There is no password to turn off.", 409);
    await access.passwordOff({ current: offBody.parse(req.body).current, ip: ip(req), ua: ua(req) });
    clear(req, reply);
    return { ok: true };
  });

  /**
   * The Access settings (and the new-device notice's channels): a sign-in of the last 10 minutes, or the password with them
   * (access.ts mayChange), since each loosens what a password guards. "From this computer" is refused while Afflatus
   * listens on loopback only (access.ts bypassOn).
   */
  app.post("/api/session/settings", async (req) => {
    const { current, newDevice, ...asked } = settingsBody.parse(req.body);
    if (asked.localNoPassword && !access.bypassAllowed()) {
      throw httpError("Afflatus listens on this computer only: anyone reaching it from elsewhere comes through something on this computer that forwards connections, which looks like this computer. The exemption is offered once it listens on the network (HOST).", 409);
    }
    await access.mayChange(req.access.session, current, ip(req));
    await access.changeSettings(asked, newDevice);
    return { ok: true };
  });

  /** The metrics token made (shown once) or taken off, under the same rule as the settings above. */
  app.post("/api/session/metrics-token", async (req) => {
    const b = metricsBody.parse(req.body);
    await access.mayChange(req.access.session, b.current, ip(req));
    return { token: await access.metricsToken(b.make) };
  });
}
