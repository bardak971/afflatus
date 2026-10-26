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
/** The login made by pasting the token (lock.py's TOKEN_LOGIN): it holds as long as the token. */
const TOKEN_LOGIN = "token";
const LOGIN_ID = /^[0-9a-f]{32}$/;

/**
 * The Afflatus node pack's lock, as lock.py does it: once locked, every route needs the token (Bearer, `?token=` on the
 * websocket, or the login cookie), else a 401 that says it is the lock; with `local`, a call from this machine through no
 * proxy gets in without it (every call to the fake comes from this machine). And its routes: the state, lock, unlock,
 * a one-time login code, the logins still good, and the login page. A login cookie names its login and holds while
 * Afflatus names it (no lease here: lock.py's tests have it), or always for the token's.
 */
export function fakeLock(fake: FakeState) {
  const codes = new Map<string, string>();
  const cookieOf = (token: string, login: string) => `${login}.${token.length}-${token.slice(0, 4)}`;
  const letIn = (headers: IncomingMessage["headers"], url: URL): boolean => {
    const lock = fake.lock;
    if (!lock) return true;
    const auth = String(headers.authorization ?? "");
    if (/^bearer /i.test(auth) && auth.slice(7).trim() === lock.token) return true;
    if (url.pathname === "/ws" && url.searchParams.get("token") === lock.token) return true;
    const sent = String(headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
    const login = sent.split(".")[0] ?? "";
    if (sent === cookieOf(lock.token, login) && (login === TOKEN_LOGIN || fake.logins.includes(login))) return true;
    return lock.local && !headers["x-forwarded-for"] && !headers.forwarded;
  };
  const loginsOf = (got: unknown): string[] | null => (Array.isArray(got) && got.every((x) => typeof x === "string" && LOGIN_ID.test(x)) ? (got as string[]) : null);
  const isJson = (r: FakeRequest) => /^application\/json\b/.test(String(r.headers["content-type"] ?? ""));
  return {
    letIn,
    /** The lock in front of every route, and its own routes: true when it answered the request. */
    route(r: FakeRequest): boolean {
      if (!fakeCanLock(fake)) return false;
      const { method, path } = r;
      if (path === "/afflatus/login" && method === "GET") {
        const code = r.url.searchParams.get("code");
        const login = code ? codes.get(code) : undefined;
        if (fake.lock && code && login !== undefined) {
          codes.delete(code);
          return r.plain(302, "", "text/plain", { location: r.url.searchParams.get("next") ?? "/", "set-cookie": `${COOKIE}=${cookieOf(fake.lock.token, login)}; HttpOnly; SameSite=Lax; Path=/` });
        }
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
        fake.logins = [];
        return r.json(200, { locked: true, local: fake.lock.local });
      }
      if (path === "/afflatus/unlock" && method === "POST") {
        if (!isJson(r)) return r.json(415, { error: "a JSON body is expected" });
        fake.lock = null;
        fake.logins = [];
        return r.json(200, { locked: false });
      }
      if (path === "/afflatus/login-code" && method === "POST") {
        if (!fake.lock) return r.plain(409, "not locked");
        const sent = JSON.parse(r.raw.toString("utf-8") || "{}") as { login?: unknown; keep?: unknown };
        let login = TOKEN_LOGIN;
        if (sent.login !== undefined) {
          const keep = loginsOf(sent.keep);
          if (typeof sent.login !== "string" || !keep?.includes(sent.login)) return r.plain(400, "a login is one of the logins still good (keep)");
          fake.logins = [...keep];
          login = sent.login;
        }
        const code = randomBytes(12).toString("base64url");
        codes.set(code, login);
        return r.json(200, { code, seconds: 60 });
      }
      if (path === "/afflatus/logins" && method === "POST") {
        if (!isJson(r)) return r.json(415, { error: "a JSON body is expected" });
        const keep = loginsOf((JSON.parse(r.raw.toString("utf-8") || "{}") as { keep?: unknown }).keep);
        if (!keep) return r.plain(400, "keep is a list of logins");
        fake.logins = [...keep];
        return r.json(200, { kept: new Set(keep).size });
      }
      return false;
    },
  };
}
