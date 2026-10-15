import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Access, Granted } from "./access";
import { loadConfig } from "./config";
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
      /** It needs no session: no password, or this computer's and "From this computer" is on. */
      open: boolean;
      /** Its session's id, when its cookie names a good one. */
      session: string | null;
    };
  }
}

/**
 * The API routes open without a session, by method and route: the probe's health, the sign-in page's own (its state, the
 * sign-in, the sign-out, a reset code asked for and used), and the one-time address ComfyUI or a pod fetches a download
 * from, which carries a token of its own (downloads.ts). The rest of /api, the event stream included, is locked.
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
 * The cookies, named by the port: two Afflatus on one computer (another port, a demo beside the real one) are one site
 * to the browser, whose cookies do not tell ports apart: one name each, or a sign-in on one would sign out the other.
 */
export const cookieNames = (port: number) => ({ session: `afflatus_session_${port}`, device: `afflatus_device_${port}` });

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
 * One Set-Cookie: HttpOnly (no script of the page reads it), SameSite=Lax (another site's page does not send it with a
 * request of its own), Secure over https. No Max-Age: the browser's session.
 */
export function cookie(name: string, value: string, opts: { maxAgeS: number | null; secure: boolean }): string {
  return [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", ...(opts.maxAgeS !== null ? [`Max-Age=${opts.maxAgeS}`] : []), ...(opts.secure ? ["Secure"] : [])].join("; ");
}

/** A device's own cookie lives as long as browsers allow (400 days): it is what tells a device seen before from a new one. */
const DEVICE_AGE_S = 400 * 86_400;

const signInBody = z.object({ password: z.string().max(2000), remember: z.boolean().default(true) });
const forgotBody = z.object({ via: z.enum(["telegram", "computer"]) });
const resetBody = z.object({ code: z.string().max(20), password: z.string().max(2000), signOutOthers: z.boolean().default(true) });
const passwordBody = z.object({ current: z.string().max(2000).default(""), password: z.string().max(2000), signOutOthers: z.boolean().default(false) });
const offBody = z.object({ current: z.string().max(2000) });
const everywhereBody = z.object({ keepThis: z.boolean().default(false) });

/** The lock's hook: registered right after the host and site checks (app.ts), before every route. */
export function registerAccessHook(app: FastifyInstance, access: Access): void {
  const names = cookieNames(loadConfig().port);
  app.decorateRequest("access", null as unknown as FastifyRequest["access"]);
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    const route = req.routeOptions.url;
    // the path as asked and the route it found are both looked at: a path the router decodes ("/%61pi/…") is still the API
    const api = path === "/api" || path.startsWith("/api/") || Boolean(route?.startsWith("/api/"));
    const local = fromThisComputer(req);
    const a = await access.settings();
    const locked = a.password !== null;
    const bypass = !locked || (local && a.localNoPassword);
    const session = locked && api ? ((await access.sessionOf(cookiesOf(req.headers.cookie)[names.session], req.socket.remoteAddress ?? ""))?.id ?? null) : null;
    req.access = { locked, local, open: bypass, session };
    if (!api || bypass || session || openRoute(req.method, route)) return;
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
  const secure = (req: FastifyRequest) => req.protocol === "https";
  const deviceOf = (req: FastifyRequest) => cookiesOf(req.headers.cookie)[names.device];

  /** The cookies of a session just given. */
  const give = (req: FastifyRequest, reply: FastifyReply, g: Granted) => {
    reply.header("Set-Cookie", [
      cookie(names.session, g.token, { maxAgeS: g.maxAgeS, secure: secure(req) }),
      cookie(names.device, g.device, { maxAgeS: DEVICE_AGE_S, secure: secure(req) }),
    ]);
  };
  /** The session's cookie taken off this browser (its device cookie stays: it is still a device seen before). */
  const clear = (req: FastifyRequest, reply: FastifyReply) => reply.header("Set-Cookie", cookie(names.session, "", { maxAgeS: 0, secure: secure(req) }));

  /** What the page needs before anything else: is there a password, is this browser in, may a code go to Telegram. */
  const state = async (req: FastifyRequest) => {
    const a = await access.settings();
    const ways = await access.resetWays();
    return {
      locked: a.password !== null,
      signedIn: req.access.open || req.access.session !== null,
      local: req.access.local,
      localNoPassword: a.localNoPassword,
      session: req.access.session !== null,
      stayDays: a.stayDays,
      telegram: a.password !== null && ways.telegram,
      wait: Math.ceil(access.passwordTries.waitMs(ip(req)) / 1000),
      sendAgain: access.sendAgainS(),
    };
  };
  app.get("/api/session", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return state(req);
  });

  app.post("/api/session/sign-in", async (req, reply) => {
    const b = signInBody.parse(req.body);
    const granted = await access.signIn({ password: b.password, remember: b.remember, ip: ip(req), ua: ua(req), device: deviceOf(req) });
    give(req, reply, granted);
    return { ok: true };
  });

  app.post("/api/session/sign-out", async (req, reply) => {
    await access.signOut(req.access.session);
    clear(req, reply);
    return { ok: true };
  });

  app.post("/api/session/forgot", async (req) => access.forgot(forgotBody.parse(req.body).via, ip(req)));

  app.post("/api/session/reset", async (req, reply) => {
    const b = resetBody.parse(req.body);
    const granted = await access.reset({ ...b, ip: ip(req), ua: ua(req), device: deviceOf(req), session: req.access.session });
    give(req, reply, granted);
    return { ok: true };
  });

  /** Settings › Access: where Afflatus listens, the devices signed in. Behind the lock. */
  app.get("/api/session/devices", async (req) => {
    const bound = config.host;
    const everywhere = bound === "0.0.0.0" || bound === "::" || bound === "[::]";
    const loopback = /^127\./.test(bound) || bound === "::1" || bound === "localhost";
    return { listen: { host: bound, port: config.port, reach: loopback ? "computer" : everywhere ? "network" : "address" }, devices: await access.devices(req.access.session) };
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
    const granted = await access.setPassword({ ...b, ip: ip(req), ua: ua(req), device: deviceOf(req), session: req.access.session, bypass: req.access.local && (await access.settings()).localNoPassword });
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
}
