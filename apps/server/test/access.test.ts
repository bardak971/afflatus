import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, get as httpGet, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Access, checkPassword, codeRead, codeShown, deviceName, hashPassword, IDLE_MS, resetAccess, TELEGRAM_HOLD_MS, Tries, TRY_LIMITS } from "../src/access";
import { cookie, cookieCount, cookieNames, cookiesOf, openRoute, overHttps } from "../src/access-api";
import { fromThisComputer } from "../src/hostCheck";
import { readSettings, updateSettings, writeSettings } from "../src/settings";
import { migrate, openSqlite } from "../src/db";
import { resetPasswordCommand, start } from "../src/start";
import { FAST, makeApp, makeFake, type TestApp } from "./helpers";

/**
 * The optional password (access.ts, access-api.ts): the lock on the API and on /metrics, what stays open, "from this
 * computer" (off by default, refused while Afflatus listens on loopback only), the hash kept and never shown, the limits on
 * wrong tries (bursts included) and the owner told of them, the reset codes tied to their browser, the sessions and their
 * cookies, the event stream, the ways back in without the page, and the notice of a new device.
 */

const PASSWORD = "correct horse battery";
const NAMES = cookieNames(8720);
const LAN = "192.168.1.20";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const quiet = { log: () => {}, warn: () => {} };

let t: TestApp;
/** The cookies of the browser that set the password: signed in by setting it. */
let owner = "";
beforeEach(async () => {
  owner = "";
  t = await makeApp();
  // the codes and the sign-ins are logged: kept out of the test's output
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await t.close();
});

type Opts = { from?: string; cookie?: string; ua?: string; headers?: Record<string, string>; body?: unknown; raw?: string };
/** A request from another machine of the network (LAN) unless `from` says otherwise, with this browser's cookies. */
const ask = (method: string, url: string, o: Opts = {}) =>
  t.app.inject({
    method: method as "GET", url, remoteAddress: o.from ?? LAN,
    headers: { "user-agent": o.ua ?? CHROME, ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers },
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
    ...(o.raw !== undefined ? { payload: o.raw } : {}),
  });
/** The cookies an answer set, as a Cookie header sends them back. */
const jar = (res: { headers: Record<string, unknown> }) => {
  const set = [res.headers["set-cookie"] ?? []].flat() as string[];
  return set.map((c) => c.split(";")[0]!).filter((c) => !c.endsWith("=")).join("; ");
};
/** The password set from this computer (inject's own request: 127.0.0.1, Host localhost); that browser is signed in by it. */
const setPassword = async (password = PASSWORD) => {
  const res = await t.app.inject({ method: "POST", url: "/api/session/password", payload: { password } });
  expect(res.statusCode).toBe(200);
  owner = jar(res);
};
const signIn = async (o: Opts & { password?: string; remember?: boolean } = {}) => ask("POST", "/api/session/sign-in", { ...o, body: { password: o.password ?? PASSWORD, remember: o.remember ?? true } });
/** A pretend Telegram on this machine: what it was sent, as the bot and chat it was sent to and the text. */
async function fakeTelegram(): Promise<{ heard: Array<{ url: string; chat: string; text: string }>; close(): Promise<void> }> {
  const heard: Array<{ url: string; chat: string; text: string }> = [];
  const site: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(parts).toString() || "{}") as { text?: string; chat_id?: string };
      heard.push({ url: req.url ?? "", chat: String(body.chat_id ?? ""), text: body.text ?? "" });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  vi.stubEnv("TELEGRAM_URL", `http://127.0.0.1:${(site.address() as AddressInfo).port}`);
  return { heard, close: () => new Promise((r) => site.close(() => r())) };
}
const BOT = "123456789:AAE_test-token-0123456789abcdef";
const OTHER_BOT = "987654321:AAE_their-token-0123456789abcdef";

/** The owner's session made older than the 10 minutes a change of the Access settings takes without the password. */
const age = async () => {
  await t.db.updateTable("sessions").set({ created_at: new Date(Date.now() - 11 * 60_000).toISOString() }).execute();
};

describe("the lock", () => {
  it("leaves everything open while there is no password", async () => {
    expect((await ask("GET", "/api/settings")).statusCode).toBe(200);
    expect((await ask("GET", "/api/session")).json()).toMatchObject({ locked: false, signedIn: true, local: false });
  });

  it("locks every API route without a session once a password is set, and opens them with one", async () => {
    await setPassword();
    for (const url of ["/api/settings", "/api/queue", "/api/assets", "/api/recipes", "/api/session/devices", "/api/events", "/%61pi/settings"]) {
      const res = await ask("GET", url);
      expect(res.statusCode, url).toBe(401);
      expect(res.headers["x-afflatus-sign-in"]).toBe("1");
      expect(res.json()).toMatchObject({ signIn: true });
    }
    expect((await ask("PUT", "/api/settings", { body: { tagCheck: false } })).statusCode).toBe(401);
    expect((await readSettings(t.db)).tagCheck).toBe(true);
    const cookies = jar(await signIn());
    expect((await ask("GET", "/api/settings", { cookie: cookies })).statusCode).toBe(200);
    expect((await ask("GET", "/api/session", { cookie: cookies })).json()).toMatchObject({ locked: true, signedIn: true, session: true });
    // a made-up token is no session
    expect((await ask("GET", "/api/settings", { cookie: `${NAMES.session}=${"x".repeat(43)}` })).statusCode).toBe(401);
  });

  it("keeps the probe's health, the sign-in page's routes and the one-time download address open", async () => {
    await setPassword();
    const health = await ask("GET", "/api/health", { headers: { host: "localhost:8720" } });
    expect(health.statusCode).toBe(200);
    // locked and not signed in, the health says only that it is alive: its checks name this computer's folders
    expect(Object.keys(health.json()).sort()).toEqual(["ok", "version"]);
    // and the sign-in page is told only what it needs: not whether this computer is exempt
    const state = (await ask("GET", "/api/session")).json();
    expect(state).toMatchObject({ locked: true, signedIn: false });
    expect(state).not.toHaveProperty("localNoPassword");
    expect(state).not.toHaveProperty("local");
    expect((await ask("POST", "/api/session/sign-out", { body: {} })).statusCode).toBe(200);
    expect((await ask("POST", "/api/session/forgot", { body: { via: "computer" } })).statusCode).toBe(200);
    expect((await ask("POST", "/api/session/reset", { body: { code: "00000-00000", password: "another password" } })).statusCode).toBe(400);
    // the download address answers by its own token: a 404 for a token that is not good, never a 401
    expect((await ask("GET", "/api/downloads/fetch/nothing?t=x")).statusCode).toBe(404);
    expect(openRoute("HEAD", "/api/downloads/fetch/:id")).toBe(true);
    expect(openRoute("POST", "/api/health")).toBe(false);
    expect(openRoute("GET", undefined)).toBe(false);
  });

  it("takes only small JSON bodies on the open routes: no file streamed to disk for anyone", async () => {
    await setPassword();
    const file = await ask("POST", "/api/session/sign-in", { headers: { "content-type": "application/octet-stream" }, raw: "x".repeat(1024) });
    expect(file.statusCode).toBe(415);
    const form = await ask("POST", "/api/session/forgot", { headers: { "content-type": "text/plain", "x-afflatus": "1" }, raw: "via=computer" });
    expect(form.statusCode).toBe(415);
    const big = await ask("POST", "/api/session/sign-in", { headers: { "content-type": "application/json" }, raw: JSON.stringify({ password: "x".repeat(20_000) }) });
    expect(big.statusCode).toBe(413);
  });

  it("opens everything again once the password is turned off, with the password", async () => {
    await setPassword();
    const cookies = jar(await signIn());
    expect((await ask("POST", "/api/session/password/off", { cookie: cookies, body: { current: "not it at all" } })).statusCode).toBe(403);
    expect((await ask("POST", "/api/session/password/off", { cookie: cookies, body: { current: PASSWORD } })).statusCode).toBe(200);
    expect((await ask("GET", "/api/settings")).statusCode).toBe(200);
    expect((await t.db.selectFrom("sessions").select("id").execute()).length).toBe(0);
  });

  it("takes a session cookie that comes twice for none (one planted by a page on another port)", async () => {
    await setPassword();
    const mine = jar(await signIn());
    const value = cookiesOf(mine)[NAMES.session]!;
    expect((await ask("GET", "/api/settings", { cookie: `${NAMES.session}=planted; ${NAMES.session}=${value}` })).statusCode).toBe(401);
    expect((await ask("GET", "/api/settings", { cookie: `${NAMES.session}=${value}; ${NAMES.session}=planted` })).statusCode).toBe(401);
    expect(cookieCount(`a=1; ${NAMES.session}=x; b=2`, NAMES.session)).toBe(1);
  });
});

describe("from this computer", () => {
  const req = (ip: string, host: string | undefined, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: ip }, headers: { ...(host === undefined ? {} : { host }), ...headers } }) as unknown as Parameters<typeof fromThisComputer>[0];
  const local = { from: "127.0.0.1", headers: { host: "localhost:8720" } };

  it("is a loopback address asked by a loopback name, any port", () => {
    expect(fromThisComputer(req("127.0.0.1", "localhost:8721"))).toBe(true);
    expect(fromThisComputer(req("127.0.0.1", "127.0.0.1:9"))).toBe(true);
    expect(fromThisComputer(req("::1", "[::1]:8720"))).toBe(true);
    expect(fromThisComputer(req("::ffff:127.0.0.1", "localhost"))).toBe(true);
  });

  it("is not another address, another name, or no name", () => {
    expect(fromThisComputer(req(LAN, "localhost:8721"))).toBe(false);
    expect(fromThisComputer(req("::ffff:192.168.1.20", "localhost"))).toBe(false);
    // Docker: the host's own requests come from the bridge
    expect(fromThisComputer(req("172.17.0.1", "localhost:8720"))).toBe(false);
    expect(fromThisComputer(req("127.0.0.1", "pc.lan:8721"))).toBe(false);
    expect(fromThisComputer(req("127.0.0.1", "192.168.1.5:8721"))).toBe(false);
    expect(fromThisComputer(req("127.0.0.1", undefined))).toBe(false);
  });

  it("is never a request that carries a forwarding header, whatever it says", () => {
    for (const h of ["x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip", "cf-connecting-ip", "true-client-ip", "x-forwarded-proto", "via"]) {
      expect(fromThisComputer(req("127.0.0.1", "localhost:8721", { [h]: "127.0.0.1" })), h).toBe(false);
    }
  });

  it("needs the password by default", async () => {
    await setPassword();
    expect((await readSettings(t.db)).access.localNoPassword).toBe(false);
    expect((await ask("GET", "/api/settings", local)).statusCode).toBe(401);
  });

  it("cannot be turned on while Afflatus listens on loopback only, nor takes effect if stored on", async () => {
    vi.stubEnv("HOST", "127.0.0.1");
    await setPassword();
    const res = await ask("POST", "/api/session/settings", { cookie: owner, body: { localNoPassword: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("forwards connections");
    expect((await ask("GET", "/api/session/devices", { cookie: owner })).json()).toMatchObject({ canBypass: false });
    // stored on all the same (a setting from elsewhere): a forwarder on this computer gets nothing by it
    await updateSettings(t.db, (s) => ({ access: { ...s.access, localNoPassword: true } }));
    expect((await ask("GET", "/api/settings", local)).statusCode).toBe(401);
  });

  it("lets this computer in once turned on while listening on the network, still only loopback, a local name and no proxy", async () => {
    vi.stubEnv("HOST", "0.0.0.0");
    await setPassword();
    expect((await ask("POST", "/api/session/settings", { cookie: owner, body: { localNoPassword: true } })).statusCode).toBe(200);
    expect((await ask("GET", "/api/settings", local)).statusCode).toBe(200);
    expect((await ask("GET", "/api/settings", { from: "127.0.0.1", headers: { host: "localhost:8720", "x-forwarded-for": "203.0.113.9" } })).statusCode).toBe(401);
    expect((await ask("GET", "/api/settings", { headers: { host: "localhost:8720" } })).statusCode).toBe(401);
    // the page in is told; one out is not
    expect((await ask("GET", "/api/session", local)).json()).toMatchObject({ local: true, localNoPassword: true });
  });
});

describe("the password", () => {
  it("is kept as a salted scrypt hash, never sent to the page", async () => {
    await setPassword();
    const row = await t.db.selectFrom("settings").select("value").where("key", "=", "access").executeTakeFirstOrThrow();
    const stored = (JSON.parse(row.value) as { password: { hash: string } }).password.hash;
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$[\w+/=]+\$[\w+/=]+$/);
    expect(row.value).not.toContain(PASSWORD);
    // the same password twice: two salts, two hashes, both right
    const again = await hashPassword(PASSWORD);
    expect(again).not.toBe(stored);
    expect(await checkPassword(PASSWORD, again)).toBe(true);
    expect(await checkPassword("nope nope", again)).toBe(false);
    expect(await checkPassword(PASSWORD, "garbage")).toBe(false);
    const settings = (await ask("GET", "/api/settings", { cookie: owner })).body;
    expect(settings).not.toContain("scrypt$");
    expect(JSON.parse(settings).access).toMatchObject({ hasPassword: true, localNoPassword: false, stayDays: 30, hasMetricsToken: false });
  });

  it("cannot be written through the settings, nor any Access setting", async () => {
    const res = await t.app.inject({ method: "PUT", url: "/api/settings", payload: { access: { password: { hash: "scrypt$1$1$1$a$b", setAt: "x" }, stayDays: 7 } } });
    expect(res.statusCode).toBe(403);
    const a = (await readSettings(t.db)).access;
    expect(a.password).toBeNull();
    expect(a.stayDays).toBe(30);
  });

  it("is 8 characters at least, and a change needs the current one", async () => {
    expect((await t.app.inject({ method: "POST", url: "/api/session/password", payload: { password: "short" } })).statusCode).toBe(400);
    await setPassword();
    expect((await ask("POST", "/api/session/password", { cookie: owner, body: { password: "a new password" } })).statusCode).toBe(403);
    expect((await ask("POST", "/api/session/password", { cookie: owner, body: { current: PASSWORD, password: "a new password" } })).statusCode).toBe(200);
    expect((await signIn()).statusCode).toBe(403);
    expect((await signIn({ password: "a new password" })).statusCode).toBe(200);
  });

  it("set from another machine signs that machine in, so that it is not locked out by its own change", async () => {
    const res = await ask("POST", "/api/session/password", { body: { password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect((await ask("GET", "/api/settings", { cookie: jar(res) })).statusCode).toBe(200);
  });

  it("changed with Sign out every other device, ends the others' sessions and keeps this one", async () => {
    await setPassword();
    const mine = jar(await signIn());
    const phone = jar(await signIn({ from: "192.168.1.44", ua: IPHONE }));
    const res = await ask("POST", "/api/session/password", { cookie: mine, body: { current: PASSWORD, password: "a new password", signOutOthers: true } });
    expect(res.statusCode).toBe(200);
    expect((await ask("GET", "/api/settings", { cookie: mine })).statusCode).toBe(200);
    expect((await ask("GET", "/api/settings", { from: "192.168.1.44", cookie: phone })).statusCode).toBe(401);
  });
});

describe("the Access settings", () => {
  it("change with a sign-in of the last 10 minutes, else with the password", async () => {
    await setPassword();
    expect((await ask("POST", "/api/session/settings", { cookie: owner, body: { stayDays: 7 } })).statusCode).toBe(200);
    await age();
    const asked = await ask("POST", "/api/session/settings", { cookie: owner, body: { resetTelegram: false } });
    expect(asked.statusCode).toBe(403);
    expect(asked.json()).toMatchObject({ needPassword: true });
    expect((await ask("POST", "/api/session/settings", { cookie: owner, body: { resetTelegram: false, current: "wrong one!" } })).statusCode).toBe(403);
    expect((await ask("POST", "/api/session/settings", { cookie: owner, body: { resetTelegram: false, current: PASSWORD } })).statusCode).toBe(200);
    const a = (await readSettings(t.db)).access;
    expect([a.stayDays, a.resetTelegram]).toEqual([7, false]);
  });

  it("hold the new-device notice too, through Access or the notifications' grid", async () => {
    await setPassword();
    await age();
    expect((await ask("PUT", "/api/settings", { cookie: owner, body: { notify: { events: { newDevice: { telegram: false } } } } })).json()).toMatchObject({ needPassword: true });
    expect((await ask("POST", "/api/session/settings", { cookie: owner, body: { newDevice: { telegram: false }, current: PASSWORD } })).statusCode).toBe(200);
    expect((await readSettings(t.db)).notify.events.newDevice.telegram).toBe(false);
    // the other kinds are not held
    expect((await ask("PUT", "/api/settings", { cookie: owner, body: { notify: { events: { renderDone: { telegram: true } } } } })).statusCode).toBe(200);
  });

  it("tell the streams at once", async () => {
    await setPassword();
    const heard = vi.fn();
    t.services.access.on("changed", heard);
    await ask("POST", "/api/session/settings", { cookie: owner, body: { stayDays: 90 } });
    expect(heard).toHaveBeenCalled();
  });
});

describe("/metrics", () => {
  it("is open without a password, and locked with one but for a session or the metrics token", async () => {
    expect((await ask("GET", "/metrics")).statusCode).toBe(200);
    await setPassword();
    const out = await ask("GET", "/metrics", { headers: { host: "localhost:8720" } });
    expect(out.statusCode).toBe(401);
    expect(out.body).not.toContain("afflatus_");
    expect((await ask("GET", "/metrics", { cookie: owner })).statusCode).toBe(200);
    const made = await ask("POST", "/api/session/metrics-token", { cookie: owner, body: { make: true } });
    const token = made.json().token as string;
    expect(token).toMatch(/^afm_/);
    expect(JSON.stringify(await readSettings(t.db))).not.toContain(token);
    expect((await ask("GET", "/metrics", { headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await ask("GET", "/metrics", { headers: { authorization: `Bearer ${token}x` } })).statusCode).toBe(401);
    await ask("POST", "/api/session/metrics-token", { cookie: owner, body: { make: false } });
    expect((await ask("GET", "/metrics", { headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });
});

describe("wrong tries", () => {
  it("wait 1, then 5, then 15 minutes per address, start afresh after a right one or a quiet day", () => {
    let now = 0;
    const tries = new Tries(() => now);
    for (let i = 4; i >= 1; i--) expect(tries.failed("a")).toEqual({ left: i, waitMs: 0, alarm: false });
    expect(tries.failed("a")).toEqual({ left: 0, waitMs: 60_000, alarm: false });
    expect(tries.waitMs("a")).toBe(60_000);
    expect(tries.waitMs("b")).toBe(0);
    now += 60_000;
    for (let i = 0; i < 4; i++) tries.failed("a");
    expect(tries.failed("a").waitMs).toBe(300_000);
    now += 300_000;
    for (let i = 0; i < 4; i++) tries.failed("a");
    // the longest wait reached: the owner is told
    expect(tries.failed("a")).toMatchObject({ waitMs: 900_000, alarm: true });
    now += 900_000;
    for (let i = 0; i < 4; i++) tries.failed("a");
    expect(tries.failed("a").waitMs).toBe(900_000);
    tries.succeeded("a");
    expect(tries.failed("a")).toMatchObject({ left: 4, waitMs: 0 });
    for (let i = 0; i < 5; i++) tries.failed("c");
    now += TRY_LIMITS.quietMs + 1;
    for (let i = 0; i < 4; i++) tries.failed("c");
    expect(tries.failed("c").waitMs).toBe(60_000);
  });

  it("stop everyone for a minute past 30 wrong in a minute from any addresses (a proxy that hides them)", () => {
    let now = 0;
    const tries = new Tries(() => now);
    for (let i = 0; i < 29; i++) tries.failed(`10.0.0.${i}`);
    expect(tries.waitMs("10.9.9.9")).toBe(0);
    expect(tries.failed("10.0.1.1").alarm).toBe(true);
    expect(tries.waitMs("10.9.9.9")).toBe(60_000);
    expect(tries.lastMinute()).toEqual({ wrong: 30, addresses: 30 });
    now += 60_000;
    expect(tries.waitMs("10.9.9.9")).toBe(0);
  });

  it("say the tries left, then the wait, through the sign-in", async () => {
    await setPassword();
    for (let left = 4; left >= 1; left--) {
      const res = await signIn({ password: "wrong password" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "Wrong password", left });
    }
    const fifth = await signIn({ password: "wrong password" });
    expect(fifth.json()).toMatchObject({ left: 0, wait: 60 });
    // the right password now waits too
    const waiting = await signIn();
    expect(waiting.statusCode).toBe(429);
    expect(waiting.json().wait).toBeGreaterThan(50);
    expect(waiting.headers["retry-after"]).toBeDefined();
    expect((await ask("GET", "/api/session")).json().wait).toBeGreaterThan(50);
    expect((await signIn({ from: "192.168.1.44" })).statusCode).toBe(200);
  });

  it("hold for a burst sent at once: every wrong one counts, and the right one among them waits", async () => {
    await setPassword();
    const burst = await Promise.all([...Array.from({ length: 15 }, () => signIn({ password: "wrong password" })), signIn()]);
    const codes = burst.map((r) => r.statusCode);
    expect(codes).not.toContain(200);
    expect(codes.filter((c) => c === 403)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(11);
    expect(t.services.access.passwordTries.waitMs(LAN)).toBeGreaterThan(0);
  });

  it("tell the owner on Telegram, once, when everyone has to wait", async () => {
    const heard: string[] = [];
    const site: Server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        heard.push((JSON.parse(Buffer.concat(parts).toString()) as { text: string }).text);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, result: {} }));
      });
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    try {
      vi.stubEnv("TELEGRAM_URL", `http://127.0.0.1:${(site.address() as AddressInfo).port}`);
      await setPassword();
      await writeSettings(t.db, { notify: { telegramToken: "123456789:AAE_test-token-0123456789abcdef", telegramChat: "42" } });
      for (let i = 0; i < 30; i++) await signIn({ from: `10.0.0.${i % 8}`, password: "wrong password" });
      await vi.waitFor(() => expect(heard.join("\n")).toContain("Sign-in attempts are being refused: 30 wrong tries in the last minute from 8 addresses."));
      expect(heard.filter((h) => h.includes("refused"))).toHaveLength(1);
      expect((await ask("GET", "/api/session/devices", { cookie: owner })).json().alarm.said).toContain("30 wrong tries");
      // the owner's session goes on meanwhile
      expect((await ask("GET", "/api/settings", { cookie: owner })).statusCode).toBe(200);
    } finally {
      await new Promise((r) => site.close(r));
    }
  });
});

describe("reset codes", () => {
  /** An Access of its own on the test's database, with a clock the test moves, its console kept. */
  const own = (now: () => number, logFile?: string) => {
    const lines: string[] = [];
    const a = new Access(t.db, t.services.notify, { now, logFile, log: { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) } });
    // the last code written, for the browser that asked last
    return { a, lines, code: () => [...lines.join("\n").matchAll(/RESET CODE: ([0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5})/g)].at(-1)?.[1] ?? "" };
  };
  const who = { ip: LAN, ua: CHROME, device: undefined, session: null };
  const wrongOf = (code: string) => (code === "00000-00000" ? "11111-11111" : "00000-00000");

  it("are written to the console and the log file, work once in the browser that asked, and set the new password", async () => {
    await setPassword();
    const dir = mkdtempSync(join(tmpdir(), "afflatus-log-"));
    try {
      const log = join(dir, "logs", "afflatus.log");
      const { a, code } = own(Date.now, log);
      const { nonce } = await a.forgot("computer", LAN, undefined);
      expect(code()).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
      expect(readFileSync(log, "utf8")).toContain(`password reset code: ${code()}`);
      // another browser (no nonce, or another one) finds no code, and spends nothing of this one
      await expect(a.reset({ ...who, nonce: undefined, code: code(), password: "a brand new one", signOutOthers: true })).rejects.toMatchObject({ statusCode: 400 });
      await expect(a.reset({ ...who, nonce: "x".repeat(32), code: code(), password: "a brand new one", signOutOthers: true })).rejects.toMatchObject({ statusCode: 400 });
      await a.reset({ ...who, nonce, code: code(), password: "a brand new one", signOutOthers: true });
      expect(await checkPassword("a brand new one", (await readSettings(t.db)).access.password!.hash)).toBe(true);
      await expect(a.reset({ ...who, nonce, code: code(), password: "yet another one", signOutOthers: true })).rejects.toMatchObject({ statusCode: 400 });
      expect(readFileSync(log, "utf8")).toMatch(/reset code sent to this computer[\s\S]*password reset with a code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("go to a log file that is set aside once full, the line just written always in afflatus.log itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-log-"));
    try {
      const log = join(dir, "logs", "afflatus.log");
      const a = new Access(t.db, t.services.notify, { logFile: log, logMaxBytes: 300, log: { log: () => {}, warn: () => {} } });
      for (let i = 0; i < 12; i++) await a.audit(`zz-test sign-in ${i} from ${LAN}`);
      expect(statSync(log).size).toBeLessThan(300 + 100);
      expect(readFileSync(log, "utf8")).toContain("zz-test sign-in 11 ");
      expect(readFileSync(`${log}.1`, "utf8")).toContain("zz-test sign-in");
      expect(readdirSync(join(dir, "logs")).sort()).toEqual(["afflatus.log", "afflatus.log.1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expire after 10 minutes, and one goes to an address at most once a minute", async () => {
    await setPassword();
    let now = Date.now();
    const { a, code } = own(() => now);
    const { nonce } = await a.forgot("computer", LAN, undefined);
    await expect(a.forgot("computer", LAN, nonce)).rejects.toMatchObject({ statusCode: 429 });
    // another address is not held up by it
    await a.forgot("computer", "192.168.1.44", undefined);
    now += 10 * 60_000 + 1;
    await expect(a.reset({ ...who, nonce, code: code(), password: "a brand new one", signOutOthers: true })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("expired") });
  });

  it("are used up by 5 wrong entries of their own browser, never by another's", async () => {
    await setPassword();
    const { a, code } = own(Date.now);
    const mine = (await a.forgot("computer", LAN, undefined)).nonce;
    const ownerCode = code();
    // someone else asks for one: the owner's stays
    const theirs = (await a.forgot("computer", "10.0.0.9", undefined)).nonce;
    const theirCode = code();
    for (let left = 4; left >= 1; left--) await expect(a.reset({ ...who, ip: "10.0.0.9", nonce: theirs, code: wrongOf(theirCode), password: "a brand new one", signOutOthers: true })).rejects.toMatchObject({ left });
    await expect(a.reset({ ...who, ip: "10.0.0.9", nonce: theirs, code: wrongOf(theirCode), password: "a brand new one", signOutOthers: true })).rejects.toMatchObject({ message: expect.stringContaining("used up") });
    await expect(a.reset({ ...who, ip: "10.0.0.9", nonce: theirs, code: theirCode, password: "a brand new one", signOutOthers: true })).rejects.toMatchObject({ statusCode: 429 });
    // the owner's code still works, in the owner's browser
    await a.reset({ ...who, nonce: mine, code: ownerCode, password: "the owner's new one", signOutOthers: true });
    expect(await checkPassword("the owner's new one", (await readSettings(t.db)).access.password!.hash)).toBe(true);
  });

  it("count nothing while no code waits, and pause at most 15 minutes after too many wrong ones", async () => {
    await setPassword();
    let now = Date.now();
    const { a, code } = own(() => now);
    // entries without a code: nothing to guess, nothing counted
    for (let i = 0; i < 30; i++) await expect(a.reset({ ...who, ip: `10.1.0.${i}`, nonce: "y".repeat(32), code: "ABCDE-FGHJK", password: "a brand new one", signOutOthers: true })).rejects.toMatchObject({ statusCode: 400 });
    const mine = (await a.forgot("computer", LAN, undefined)).nonce;
    // 20 wrong entries from many addresses, each with a code of its own: codes pause for everyone, for the window
    for (let i = 0; i < 4; i++) {
      const n = (await a.forgot("computer", `10.2.0.${i}`, undefined)).nonce;
      for (let j = 0; j < 5; j++) await a.reset({ ...who, ip: `10.2.0.${i}`, nonce: n, code: wrongOf(code()), password: "a brand new one", signOutOthers: true }).catch(() => {});
    }
    await expect(a.forgot("computer", "10.3.0.1", undefined)).rejects.toMatchObject({ statusCode: 429 });
    now += 15 * 60_000 + 1;
    // the window passed: the owner asks again and is let back in
    const again = (await a.forgot("computer", LAN, mine)).nonce;
    expect(again).toBe(mine);
    await a.reset({ ...who, nonce: mine, code: code(), password: "a brand new one", signOutOthers: true });
  });

  it("never put the owner's waiting code aside for others: past 8 waiting, new ones are refused", async () => {
    await setPassword();
    const { a, code } = own(Date.now);
    const mine = (await a.forgot("computer", LAN, undefined)).nonce;
    const ownerCode = code();
    for (let i = 0; i < 7; i++) await a.forgot("computer", `10.4.0.${i}`, undefined);
    await expect(a.forgot("computer", "10.4.0.99", undefined)).rejects.toMatchObject({ statusCode: 429, message: expect.stringContaining("Codes are being asked for") });
    await a.reset({ ...who, nonce: mine, code: ownerCode, password: "the owner's new one", signOutOthers: true });
  });

  it("are entered with or without the dash, in any case, I and L for 1 and O for 0", async () => {
    await setPassword();
    const { a, code } = own(Date.now);
    const { nonce } = await a.forgot("computer", LAN, undefined);
    const typed = code().toLowerCase().replace("-", " ").replace(/1/g, "l").replace(/0/g, "o");
    await a.reset({ ...who, nonce, code: typed, password: "a brand new one", signOutOthers: true });
  });

  it("tell the owner when more than 3 are asked for in an hour, and at any wrong one", async () => {
    const tg = await fakeTelegram();
    try {
      await setPassword();
      await writeSettings(t.db, { notify: { telegramToken: BOT, telegramChat: "42" } });
      const { a, code } = own(Date.now);
      for (let i = 0; i < 4; i++) await a.forgot("computer", `10.5.0.${i}`, undefined);
      await vi.waitFor(() => expect(tg.heard.some((h) => h.text.includes("4 reset codes asked for in the last hour"))).toBe(true));
      const { nonce } = await a.forgot("computer", "10.5.0.9", undefined);
      await a.reset({ ...who, ip: "10.5.0.9", nonce, code: wrongOf(code()), password: "a brand new one", signOutOthers: true }).catch(() => {});
      await vi.waitFor(() => expect(tg.heard.some((h) => h.text.includes("A wrong reset code was entered from 10.5.0.9"))).toBe(true));
      expect(a.lastAlarm?.said).toContain("wrong reset code");
    } finally {
      await tg.close();
    }
  });

  it("are refused for the rest of the day past 100 wrong entries, saying the command line still resets", async () => {
    await setPassword();
    let now = Date.now();
    const { a, code } = own(() => now);
    let entered = 0;
    for (let round = 0; entered < 100; round++) {
      // 20 wrong entries every 15 minutes at most: the window is let pass between rounds
      for (let i = 0; i < 4 && entered < 100; i++) {
        const ip = `10.6.${round}.${i}`;
        const { nonce } = await a.forgot("computer", ip, undefined);
        for (let j = 0; j < 5; j++, entered++) await a.reset({ ...who, ip, nonce, code: wrongOf(code()), password: "a brand new one", signOutOthers: true }).catch(() => {});
      }
      now += 15 * 60_000 + 1;
    }
    const refused = await a.forgot("computer", "10.7.0.1", undefined).catch((e: Error) => e);
    expect(refused).toMatchObject({ statusCode: 429, message: expect.stringContaining("reset-password still works") });
    now += 24 * 3600_000;
    await a.forgot("computer", "10.7.0.1", undefined);
  });

  it("do not spend a try on a new password that is too short", async () => {
    await setPassword();
    const { a, code } = own(Date.now);
    const { nonce } = await a.forgot("computer", LAN, undefined);
    await expect(a.reset({ ...who, nonce, code: code(), password: "short", signOutOthers: true })).rejects.toMatchObject({ statusCode: 400 });
    await a.reset({ ...who, nonce, code: code(), password: "long enough now", signOutOthers: true });
  });

  it("go to Telegram when it is set up and allowed, tied to the browser's cookie, and Telegram is told of the change", async () => {
    const heard: string[] = [];
    const site: Server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        heard.push((JSON.parse(Buffer.concat(parts).toString()) as { text: string }).text);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, result: {} }));
      });
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    try {
      vi.stubEnv("TELEGRAM_URL", `http://127.0.0.1:${(site.address() as AddressInfo).port}`);
      await setPassword();
      expect((await ask("POST", "/api/session/forgot", { body: { via: "telegram" } })).statusCode).toBe(409);
      expect((await ask("GET", "/api/session")).json().telegram).toBe(false);
      await writeSettings(t.db, { notify: { telegramToken: "123456789:AAE_test-token-0123456789abcdef", telegramChat: "42" } });
      expect((await ask("GET", "/api/session")).json().telegram).toBe(true);
      const sent = await ask("POST", "/api/session/forgot", { body: { via: "telegram" } });
      expect(sent.statusCode).toBe(200);
      const resetCookie = ([sent.headers["set-cookie"]].flat() as string[]).find((c) => c.startsWith(`${NAMES.reset}=`))!;
      expect(resetCookie).toMatch(/Path=\/api\/session; HttpOnly; SameSite=Strict; Max-Age=600/);
      const code = /Code: ([0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5})/.exec(heard.join("\n"))?.[1];
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
      // without the browser's cookie the code finds nothing
      expect((await ask("POST", "/api/session/reset", { body: { code, password: "a brand new one" } })).statusCode).toBe(400);
      const reset = await ask("POST", "/api/session/reset", { cookie: jar(sent), body: { code, password: "a brand new one", signOutOthers: true } });
      expect(reset.statusCode).toBe(200);
      expect((await ask("GET", "/api/settings", { cookie: jar(reset) })).statusCode).toBe(200);
      // told in the background, beside the new device's own notice (the reset signs this browser in): in either order
      await vi.waitFor(() => expect(heard.some((h) => h.includes("password changed"))).toBe(true));
      await updateSettings(t.db, (s) => ({ access: { ...s.access, resetTelegram: false } }));
      expect((await ask("GET", "/api/session")).json().telegram).toBe(false);
    } finally {
      await new Promise((r) => site.close(r));
    }
  });
});


describe("Telegram's bot and chat", () => {
  it("change only with a recent sign-in or the password: a session taken over cannot point the codes at its own bot", async () => {
    const tg = await fakeTelegram();
    try {
      await setPassword();
      expect((await ask("PUT", "/api/settings", { cookie: owner, body: { notify: { telegramToken: BOT, telegramChat: "42" } } })).statusCode).toBe(200);
      await age();
      const refused = await ask("PUT", "/api/settings", { cookie: owner, body: { notify: { telegramToken: OTHER_BOT, telegramChat: "666" } } });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ needPassword: true });
      expect((await ask("PUT", "/api/settings", { cookie: owner, body: { notify: { telegramChat: "666" } } })).statusCode).toBe(403);
      expect((await readSettings(t.db)).notify.telegramChat).toBe("42");
      // the password typed again lets it through
      expect((await ask("PUT", "/api/settings", { cookie: owner, headers: { "x-afflatus-password": PASSWORD }, body: { notify: { telegramChat: "777" } } })).statusCode).toBe(200);
    } finally {
      await tg.close();
    }
  });

  it("take a password of any script, sent URI-encoded as the page sends it (a header takes nothing past U+00FF)", async () => {
    const word = "пароль 密码 🔒 vraiment";
    await setPassword(word);
    await age();
    expect((await ask("PUT", "/api/settings", { cookie: owner, headers: { "x-afflatus-password": encodeURIComponent(word) }, body: { notify: { telegramChat: "888" } } })).statusCode).toBe(200);
    expect((await readSettings(t.db)).notify.telegramChat).toBe("888");
    expect((await ask("PUT", "/api/settings", { cookie: owner, headers: { "x-afflatus-password": encodeURIComponent("not it") }, body: { notify: { telegramChat: "999" } } })).statusCode).toBe(403);
  });

  it("changed, get no reset code for 24 h, and the chat before is told", async () => {
    const tg = await fakeTelegram();
    try {
      let now = 0;
      await setPassword();
      await ask("PUT", "/api/settings", { cookie: owner, body: { notify: { telegramToken: BOT, telegramChat: "42" } } });
      tg.heard.length = 0;
      expect((await ask("PUT", "/api/settings", { cookie: owner, body: { notify: { telegramChat: "777" } } })).statusCode).toBe(200);
      await vi.waitFor(() => expect(tg.heard.some((h) => h.chat === "42" && h.text.includes("Afflatus's Telegram was changed to another chat"))).toBe(true));
      expect(tg.heard.find((h) => h.chat === "42")!.url).toContain(BOT);
      const state = (await ask("GET", "/api/session")).json();
      expect(state.telegram).toBe(false);
      expect(state.telegramHeld).toBeGreaterThan(23 * 60);
      expect((await ask("POST", "/api/session/forgot", { body: { via: "telegram" } })).statusCode).toBe(409);
      // a day later it is a way again
      const later = new Access(t.db, t.services.notify, { now: () => now, log: quiet });
      now = Date.now() + TELEGRAM_HOLD_MS + 1000;
      expect((await later.resetWays()).telegram).toBe(true);
      later.stop();
    } finally {
      await tg.close();
    }
  });
});

describe("the body of a request nobody may make", () => {
  it("is never read: an address with no route, or a locked change without a session, is answered first", async () => {
    // a temporary folder of this test's own, where the upload parser would write: other tests' uploads land elsewhere
    const own = mkdtempSync(join(tmpdir(), "afflatus-body-"));
    for (const name of ["TMP", "TEMP", "TMPDIR"]) vi.stubEnv(name, own);
    const uploads = () => readdirSync(own).filter((f) => f.startsWith("afflatus-upload-")).length;
    const before = uploads();
    expect((await ask("POST", "/nowhere", { headers: { "content-type": "application/octet-stream" }, raw: "x".repeat(64 * 1024) })).statusCode).toBe(404);
    // OPTIONS too: Fastify reads its body as any other's
    expect((await ask("OPTIONS", "/nowhere", { headers: { "content-type": "application/octet-stream" }, raw: "x".repeat(64 * 1024) })).statusCode).toBe(404);
    await setPassword();
    expect((await ask("POST", "/api/assets/upload", { headers: { "content-type": "application/octet-stream" }, raw: "x".repeat(64 * 1024) })).statusCode).toBe(401);
    expect([401, 404]).toContain((await ask("PUT", "/api/drafts/x", { headers: { "content-type": "image/png" }, raw: "x".repeat(64 * 1024) })).statusCode);
    expect(uploads()).toBe(before);
    vi.unstubAllEnvs();
    rmSync(own, { recursive: true, force: true });
  });
});

describe("the code itself", () => {
  it("is 10 characters of Crockford's base32, grouped, read whatever its case, I and L as 1, O as 0", () => {
    expect(codeShown("K7M2P9XQ4R")).toBe("K7M2P-9XQ4R");
    expect(codeRead("k7m2p-9xq4r")).toBe("K7M2P9XQ4R");
    expect(codeRead(" K7M2P 9XQ4R ")).toBe("K7M2P9XQ4R");
    expect(codeRead("ILO23-45678")).toBe("1102345678");
    expect(codeRead("K7M2P-9XQ4")).toBeNull();
    expect(codeRead("UUUUU-UUUUU")).toBeNull();
  });
});

describe("sessions", () => {
  it("set an HttpOnly, SameSite=Lax cookie, kept for the days set when remembered, for the browser's session when not", async () => {
    await setPassword();
    const remembered = [(await signIn()).headers["set-cookie"]].flat() as string[];
    const session = remembered.find((c) => c.startsWith(`${NAMES.session}=`))!;
    expect(session).toMatch(/; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    expect(remembered.find((c) => c.startsWith(`${NAMES.device}=`))).toMatch(/HttpOnly; SameSite=Lax; Max-Age=34560000/);
    const once = ([(await signIn({ remember: false })).headers["set-cookie"]].flat() as string[]).find((c) => c.startsWith(`${NAMES.session}=`))!;
    expect(once).not.toContain("Max-Age");
    const token = decodeURIComponent(session.split(";")[0]!.split("=")[1]!);
    expect((await t.db.selectFrom("sessions").select("id").execute()).map((r) => r.id)).not.toContain(token);
    expect(cookie(NAMES.session, "x", { maxAgeS: null, secure: true })).toBe(`${NAMES.session}=x; Path=/; HttpOnly; SameSite=Lax; Secure`);
    expect(cookiesOf("a=1; b=%zz; c=x%20y")).toEqual({ a: "1", c: "x y" });
  });

  it("set the cookie Secure behind an https proxy on this computer, or with an https PUBLIC_URL, never on a remote's word", async () => {
    await setPassword();
    const viaProxy = ([(await signIn({ from: "127.0.0.1", headers: { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" } })).headers["set-cookie"]].flat() as string[]).join("\n");
    expect(viaProxy).toContain("Secure");
    const remote = ([(await signIn({ headers: { "x-forwarded-proto": "https" } })).headers["set-cookie"]].flat() as string[]).join("\n");
    expect(remote).not.toContain("Secure");
    vi.stubEnv("PUBLIC_URL", "https://afflatus.example.net");
    const published = ([(await signIn({ from: "10.0.0.7" })).headers["set-cookie"]].flat() as string[]).join("\n");
    expect(published).toContain("Secure");
    const req = (ip: string, proto?: string) => ({ protocol: "http", socket: { remoteAddress: ip }, headers: proto ? { "x-forwarded-proto": proto } : {} }) as unknown as Parameters<typeof overHttps>[0];
    vi.unstubAllEnvs();
    expect(overHttps(req("::1", "https"))).toBe(true);
    expect(overHttps(req(LAN, "https"))).toBe(false);
    expect(overHttps(req("127.0.0.1"))).toBe(false);
    // a TLS proxy on another machine, named in TRUST_PROXY: its word is taken, and no other machine's
    vi.stubEnv("TRUST_PROXY", "10.0.0.2, fd00::2");
    try {
      expect(overHttps(req("10.0.0.2", "https"))).toBe(true);
      expect(overHttps(req("::ffff:10.0.0.2", "https"))).toBe(true);
      expect(overHttps(req("fd00::2", "https"))).toBe(true);
      expect(overHttps(req("10.0.0.2"))).toBe(false);
      expect(overHttps(req("10.0.0.3", "https"))).toBe(false);
      const behind = ([(await signIn({ from: "10.0.0.2", headers: { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" } })).headers["set-cookie"]].flat() as string[]).join("\n");
      expect(behind).toContain("Secure");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("end after 12 h idle when not remembered, write their last seen at most once a minute", async () => {
    await setPassword();
    let now = Date.now();
    const a = new Access(t.db, null, { now: () => now, log: quiet });
    const g = await a.signIn({ password: PASSWORD, remember: false, ip: LAN, ua: CHROME, device: undefined });
    // this sign-in's own session (its id is its token's SHA-256): the newest by created_at could be setPassword's, made in the same
    // millisecond on a fast machine, whose last seen never moves (the test failed about 1 run in 2)
    const id = createHash("sha256").update(g.token).digest("hex");
    const seen = async () => (await t.db.selectFrom("sessions").select("last_seen_at").where("id", "=", id).executeTakeFirstOrThrow()).last_seen_at;
    const first = await seen();
    now += 30_000;
    expect(await a.sessionOf(g.token, LAN)).not.toBeNull();
    expect(await seen()).toBe(first);
    now += 31_000;
    expect(await a.sessionOf(g.token, LAN)).not.toBeNull();
    expect(await seen()).not.toBe(first);
    now += IDLE_MS + 60_000;
    expect(await a.sessionOf(g.token, LAN)).toBeNull();
    const kept = await a.signIn({ password: PASSWORD, remember: true, ip: LAN, ua: CHROME, device: undefined });
    now += 29 * 86_400_000;
    expect(await a.sessionOf(kept.token, LAN)).not.toBeNull();
    now += 2 * 86_400_000;
    expect(await a.sessionOf(kept.token, LAN)).toBeNull();
    a.stop();
  });

  it("are listed, and signed out one by one or everywhere", async () => {
    await setPassword();
    await t.db.deleteFrom("sessions").execute();
    const mine = jar(await signIn());
    const phone = jar(await signIn({ from: "192.168.1.44", ua: IPHONE }));
    const third = jar(await signIn({ from: "100.88.3.17" }));
    const list = (await ask("GET", "/api/session/devices", { cookie: mine })).json() as { devices: Array<{ id: string; name: string; ip: string; here: boolean }> };
    expect(list.devices.map((d) => d.name).sort()).toEqual(["Chrome on Windows", "Chrome on Windows", "Safari on iPhone"]);
    expect(list.devices.filter((d) => d.here)).toHaveLength(1);
    const iphone = list.devices.find((d) => d.ip === "192.168.1.44")!;
    expect((await ask("POST", `/api/session/devices/${iphone.id}/sign-out`, { cookie: mine, body: {} })).statusCode).toBe(200);
    expect((await ask("GET", "/api/settings", { from: "192.168.1.44", cookie: phone })).statusCode).toBe(401);
    expect((await ask("GET", "/api/settings", { from: "100.88.3.17", cookie: third })).statusCode).toBe(200);
    expect((await ask("POST", "/api/session/sign-out-everywhere", { cookie: mine, body: { keepThis: true } })).statusCode).toBe(200);
    expect((await ask("GET", "/api/settings", { from: "100.88.3.17", cookie: third })).statusCode).toBe(401);
    expect((await ask("GET", "/api/settings", { cookie: mine })).statusCode).toBe(200);
    const out = await ask("POST", "/api/session/sign-out-everywhere", { cookie: mine, body: {} });
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await ask("GET", "/api/settings", { cookie: mine })).statusCode).toBe(401);
  });

  it("this device's sign-out ends its session", async () => {
    await setPassword();
    const mine = jar(await signIn());
    await ask("POST", "/api/session/sign-out", { cookie: mine, body: {} });
    expect((await ask("GET", "/api/settings", { cookie: mine })).statusCode).toBe(401);
  });

  it("end the live event stream once the session expires, without anything said meanwhile", async () => {
    await setPassword();
    const mine = jar(await signIn());
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = t.app.server.address() as AddressInfo;
    t.services.access.recheckEvery(50);
    const ended = new Promise<number>((resolve, reject) => {
      const req = httpGet({ host: "127.0.0.1", port, path: "/api/events", headers: { cookie: mine, host: "localhost" } }, (res) => {
        expect(res.statusCode).toBe(200);
        res.resume();
        // the stream is open: the session is let expire in the database, which nothing announces
        void t.db.updateTable("sessions").set({ expires_at: new Date(Date.now() - 1000).toISOString() }).execute();
        res.on("end", () => resolve(Date.now()));
      });
      req.on("error", reject);
    });
    expect(await ended).toBeGreaterThan(0);
  });

  it("name the device by its browser", () => {
    expect(deviceName(CHROME)).toBe("Chrome on Windows");
    expect(deviceName(IPHONE)).toBe("Safari on iPhone");
    expect(deviceName("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("Firefox on Linux");
    expect(deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0")).toBe("Edge on Windows");
    expect(deviceName("curl/8.4.0")).toBe("curl");
  });
});

describe("a new device", () => {
  it("is told of once: a device seen before signing in again is not", async () => {
    await setPassword();
    const notices: Array<{ kind: string; body: string }> = [];
    t.services.queue.events.on("notice", (n: { kind: string; body: string }) => notices.push(n));
    const first = await signIn();
    expect(notices.filter((n) => n.kind === "newDevice")).toHaveLength(1);
    expect(notices[0]!.body).toContain(`Chrome on Windows from ${LAN}`);
    await signIn({ cookie: jar(first) });
    expect(notices.filter((n) => n.kind === "newDevice")).toHaveLength(1);
    await signIn({ from: "192.168.1.44", ua: IPHONE });
    expect(notices.filter((n) => n.kind === "newDevice")).toHaveLength(2);
  });

  it("goes to Telegram by default, not Discord", async () => {
    expect((await readSettings(t.db)).notify.events.newDevice).toEqual({ telegram: true, discord: false });
  });
});

describe("the ways back in without the page", () => {
  it("resetAccess removes the password and every session", async () => {
    await setPassword();
    await signIn();
    expect(await resetAccess(t.db, quiet)).toBe(true);
    expect((await readSettings(t.db)).access.password).toBeNull();
    expect(await t.db.selectFrom("sessions").select("id").execute()).toEqual([]);
    expect((await ask("GET", "/api/settings")).statusCode).toBe(200);
  });

  it("AFFLATUS_RESET_PASSWORD=1 does it at the start, said loudly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-reset-"));
    const fake = await makeFake();
    try {
      const db = openSqlite(join(dir, "afflatus.db"));
      await migrate(db);
      await writeSettings(db, { comfyUrl: fake.url });
      await db.insertInto("settings").values({ key: "access", value: JSON.stringify({ password: { hash: await hashPassword(PASSWORD), setAt: "2026-10-15T00:00:00.000Z" } }), updated_at: "now" }).execute();
      await db.destroy();
      vi.stubEnv("AFFLATUS_RESET_PASSWORD", "1");
      const said: string[] = [];
      const started = await start({ host: "127.0.0.1", port: 0, dataDir: dir, databaseUrl: "" }, { queueOptions: FAST, log: { log: () => {}, warn: (l: string) => said.push(l) } });
      try {
        expect((await readSettings(started.services.db)).access.password).toBeNull();
        expect(said.join(" ")).toContain("THE PASSWORD WAS REMOVED");
      } finally {
        await started.close();
      }
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reset-password does it on a stopped Afflatus's data folder, and refuses while one answers on the port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-reset-"));
    try {
      const db = openSqlite(join(dir, "afflatus.db"));
      await migrate(db);
      await db.insertInto("settings").values({ key: "access", value: JSON.stringify({ password: { hash: await hashPassword(PASSWORD), setAt: "2026-10-15T00:00:00.000Z" } }), updated_at: "now" }).execute();
      await db.destroy();
      const busy = createServer();
      await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
      const port = (busy.address() as AddressInfo).port;
      const config = { host: "127.0.0.1", port, dataDir: dir, databaseUrl: "" };
      expect(await resetPasswordCommand(config, quiet)).toBe(1);
      await new Promise((r) => busy.close(r));
      expect(await resetPasswordCommand(config, quiet)).toBe(0);
      const after = openSqlite(join(dir, "afflatus.db"));
      expect((await readSettings(after)).access.password).toBeNull();
      await after.destroy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
