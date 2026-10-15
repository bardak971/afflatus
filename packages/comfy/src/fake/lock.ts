import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { FakeRequest, FakeState } from "../testing";

const atLeast = (v: string, min: string) => {
  const a = v.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

/** Whether the pretend node pack can lock (0.12.0 and newer, as the real one). */
export const fakeCanLock = (fake: FakeState) => Boolean(fake.packVersion && atLeast(fake.packVersion, "0.12.0"));

const COOKIE = "afflatus_lock_fake";

/**
 * The Afflatus node pack's lock, as lock.py does it: once locked, every route needs the token (Bearer, `?token=` on the
 * websocket, or the login cookie), else a 401 that says it is the lock; with `local`, a call from this machine through no
 * proxy gets in without it (every call to the fake comes from this machine). And its routes: the state, lock, unlock,
 * a one-time login code, and the login page.
 */
export function fakeLock(fake: FakeState) {
  const codes = new Set<string>();
  const letIn = (headers: IncomingMessage["headers"], url: URL): boolean => {
    const lock = fake.lock;
    if (!lock) return true;
    const auth = String(headers.authorization ?? "");
    if (/^bearer /i.test(auth) && auth.slice(7).trim() === lock.token) return true;
    if (url.pathname === "/ws" && url.searchParams.get("token") === lock.token) return true;
    if (String(headers.cookie ?? "").split(/;\s*/).includes(`${COOKIE}=${lock.token.length}-${lock.token.slice(0, 4)}`)) return true;
    return lock.local && !headers["x-forwarded-for"] && !headers.forwarded;
  };
  const isJson = (r: FakeRequest) => /^application\/json\b/.test(String(r.headers["content-type"] ?? ""));
  return {
    letIn,
    /** The lock in front of every route, and its own routes: true when it answered the request. */
    route(r: FakeRequest): boolean {
      if (!fakeCanLock(fake)) return false;
      const { method, path } = r;
      if (path === "/afflatus/login" && method === "GET") {
        const code = r.url.searchParams.get("code");
        if (fake.lock && code && codes.delete(code)) return r.plain(302, "", "text/plain", { location: r.url.searchParams.get("next") ?? "/", "set-cookie": `${COOKIE}=${fake.lock.token.length}-${fake.lock.token.slice(0, 4)}; HttpOnly; SameSite=Lax; Path=/` });
        return r.plain(200, "<!doctype html><title>ComfyUI is locked</title>", "text/html");
      }
      if (!letIn(r.headers, r.url)) {
        fake.refused.push(`${method} ${path}`);
        return r.json(401, { error: "locked", by: "afflatus" }, { "x-afflatus-lock": "on" });
      }
      if (path === "/afflatus/lock" && method === "GET") return r.json(200, { locked: Boolean(fake.lock), local: Boolean(fake.lock?.local), fixed: Boolean(fake.lock?.fixed), off: false });
      if ((path === "/afflatus/lock" || path === "/afflatus/unlock") && method === "POST" && fake.lock?.fixed) return r.plain(409, "locked by its start settings (AFFLATUS_TOKEN)");
      if (path === "/afflatus/lock" && method === "POST") {
        if (!isJson(r)) return r.json(415, { error: "a JSON body is expected" });
        const sent = JSON.parse(r.raw.toString("utf-8") || "{}") as { token?: unknown; local?: unknown; origin?: unknown };
        if (typeof sent.token !== "string" || sent.token.length < 16) return r.plain(400, "a token is 16 to 200 printable characters");
        fake.lock = { token: sent.token, local: sent.local === true, ...(typeof sent.origin === "string" ? { origin: sent.origin } : {}) };
        return r.json(200, { locked: true, local: fake.lock.local });
      }
      if (path === "/afflatus/unlock" && method === "POST") {
        if (!isJson(r)) return r.json(415, { error: "a JSON body is expected" });
        fake.lock = null;
        return r.json(200, { locked: false });
      }
      if (path === "/afflatus/login-code" && method === "POST") {
        if (!fake.lock) return r.plain(409, "not locked");
        const code = randomBytes(12).toString("base64url");
        codes.add(code);
        return r.json(200, { code, seconds: 60 });
      }
      return false;
    },
  };
}
