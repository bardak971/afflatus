import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Access, checkPassword, deviceName, hashPassword, IDLE_MS, resetAccess, Tries, TRY_LIMITS } from "../src/access";
import { cookie, cookieNames, cookiesOf, openRoute } from "../src/access-api";
import { fromThisComputer } from "../src/hostCheck";
import { readSettings, writeSettings } from "../src/settings";
import { migrate, openSqlite } from "../src/db";
import { resetPasswordCommand, start } from "../src/start";
import { FAST, makeApp, makeFake, type TestApp } from "./helpers";

/**
 * The optional password (access.ts, access-api.ts): the lock on the API and what stays open, "from this computer", the
 * hash kept and never shown, the limits on wrong tries, the reset codes, the sessions and their cookies, the ways back
 * in without the page, and the notice of a new device.
 */

const PASSWORD = "correct horse battery";
const NAMES = cookieNames(8720);
const LAN = "192.168.1.20";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const quiet = { log: () => {}, warn: () => {} };

let t: TestApp;
beforeEach(async () => {
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

type Opts = { from?: string; cookie?: string; ua?: string; headers?: Record<string, string>; body?: unknown };
/** A request from another machine of the network (LAN) unless `from` says otherwise, with this browser's cookies. */
const ask = (method: string, url: string, o: Opts = {}) =>
  t.app.inject({
    method: method as "GET", url, remoteAddress: o.from ?? LAN,
    headers: { "user-agent": o.ua ?? CHROME, ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers },
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
  });
/** The cookies an answer set, as a Cookie header sends them back. */
const jar = (res: { headers: Record<string, unknown> }) => {
  const set = [res.headers["set-cookie"] ?? []].flat() as string[];
  return set.map((c) => c.split(";")[0]!).filter((c) => !c.endsWith("=")).join("; ");
};
const setPassword = async (password = PASSWORD) => {
  // from this computer (the default request of inject: 127.0.0.1, Host localhost), which needs no session to set it
  const res = await t.app.inject({ method: "POST", url: "/api/session/password", payload: { password } });
  expect(res.statusCode).toBe(200);
};
const signIn = async (o: Opts & { password?: string; remember?: boolean } = {}) => ask("POST", "/api/session/sign-in", { ...o, body: { password: o.password ?? PASSWORD, remember: o.remember ?? true } });

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
    expect((await ask("GET", "/api/session")).json()).toMatchObject({ locked: true, signedIn: false });
    expect((await ask("POST", "/api/session/sign-out", { body: {} })).statusCode).toBe(200);
    expect((await ask("POST", "/api/session/forgot", { body: { via: "computer" } })).statusCode).toBe(200);
    expect((await ask("POST", "/api/session/reset", { body: { code: "000000", password: "another password" } })).statusCode).toBe(403);
    // the download address answers by its own token: a 404 for a token that is not good, never a 401
    expect((await ask("GET", "/api/downloads/fetch/nothing?t=x")).statusCode).toBe(404);
    expect(openRoute("HEAD", "/api/downloads/fetch/:id")).toBe(true);
    expect(openRoute("POST", "/api/health")).toBe(false);
    expect(openRoute("GET", undefined)).toBe(false);
  });

  it("lets this computer in without a password while that is on, and not once it is off", async () => {
    await setPassword();
    expect((await ask("GET", "/api/settings", { from: "127.0.0.1", headers: { host: "localhost:8720" } })).statusCode).toBe(200);
    // a proxy on this computer (it comes from loopback) that says whom it forwards for is not this computer
    expect((await ask("GET", "/api/settings", { from: "127.0.0.1", headers: { host: "localhost:8720", "x-forwarded-for": "203.0.113.9" } })).statusCode).toBe(401);
    // nor one that passes on the name it is reached by
    expect((await ask("GET", "/api/settings", { from: "127.0.0.1", headers: { host: "afflatus.example.net" } })).statusCode).toBe(403);
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { access: { localNoPassword: false } } });
    expect((await ask("GET", "/api/settings", { from: "127.0.0.1", headers: { host: "localhost:8720" } })).statusCode).toBe(401);
  });

  it("opens everything again once the password is turned off, with the password", async () => {
    await setPassword();
    const cookies = jar(await signIn());
    expect((await ask("POST", "/api/session/password/off", { cookie: cookies, body: { current: "not it at all" } })).statusCode).toBe(403);
    expect((await ask("POST", "/api/session/password/off", { cookie: cookies, body: { current: PASSWORD } })).statusCode).toBe(200);
    expect((await ask("GET", "/api/settings")).statusCode).toBe(200);
    expect((await t.db.selectFrom("sessions").select("id").execute()).length).toBe(0);
  });
});

describe("from this computer", () => {
  const req = (ip: string, host: string | undefined, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: ip }, headers: { ...(host === undefined ? {} : { host }), ...headers } }) as unknown as Parameters<typeof fromThisComputer>[0];

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
    const settings = (await t.app.inject({ method: "GET", url: "/api/settings" })).body;
    expect(settings).not.toContain("scrypt$");
    expect(JSON.parse(settings).access).toMatchObject({ hasPassword: true, localNoPassword: true, stayDays: 30 });
  });

  it("cannot be written through the settings, only through its own routes", async () => {
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { access: { password: { hash: "scrypt$1$1$1$a$b", setAt: "x" }, stayDays: 7 } } });
    const a = (await readSettings(t.db)).access;
    expect(a.password).toBeNull();
    expect(a.stayDays).toBe(7);
  });

  it("is 8 characters at least, and a change needs the current one", async () => {
    expect((await t.app.inject({ method: "POST", url: "/api/session/password", payload: { password: "short" } })).statusCode).toBe(400);
    await setPassword();
    expect((await t.app.inject({ method: "POST", url: "/api/session/password", payload: { password: "a new password" } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "POST", url: "/api/session/password", payload: { current: PASSWORD, password: "a new password" } })).statusCode).toBe(200);
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

describe("wrong tries", () => {
  it("wait 1, then 5, then 15 minutes per address, start afresh after a right one or a quiet day", () => {
    let now = 0;
    const tries = new Tries(() => now);
    for (let i = 4; i >= 1; i--) expect(tries.failed("a")).toEqual({ left: i, waitMs: 0 });
    expect(tries.failed("a")).toEqual({ left: 0, waitMs: 60_000 });
    expect(tries.waitMs("a")).toBe(60_000);
    expect(tries.waitMs("b")).toBe(0);
    now += 60_000;
    for (let i = 0; i < 4; i++) tries.failed("a");
    expect(tries.failed("a").waitMs).toBe(300_000);
    now += 300_000;
    for (let i = 0; i < 4; i++) tries.failed("a");
    expect(tries.failed("a").waitMs).toBe(900_000);
    now += 900_000;
    for (let i = 0; i < 4; i++) tries.failed("a");
    expect(tries.failed("a").waitMs).toBe(900_000);
    // a right one: afresh
    tries.succeeded("a");
    expect(tries.failed("a")).toEqual({ left: 4, waitMs: 0 });
    // a day without a wrong one: afresh too
    for (let i = 0; i < 4; i++) tries.failed("c");
    tries.failed("c");
    now += TRY_LIMITS.quietMs + 1;
    for (let i = 0; i < 4; i++) tries.failed("c");
    expect(tries.failed("c").waitMs).toBe(60_000);
  });

  it("stop everyone for a minute past 30 wrong in a minute from any addresses (a proxy that hides them)", () => {
    let now = 0;
    const tries = new Tries(() => now);
    for (let i = 0; i < 29; i++) tries.failed(`10.0.0.${i}`);
    expect(tries.waitMs("10.9.9.9")).toBe(0);
    tries.failed("10.0.1.1");
    expect(tries.waitMs("10.9.9.9")).toBe(60_000);
    now += 60_000;
    expect(tries.waitMs("10.9.9.9")).toBe(0);
  });

  it("say the tries left, then the wait, through the sign-in, without checking the password meanwhile", async () => {
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
    // another address is not held up
    expect((await signIn({ from: "192.168.1.44" })).statusCode).toBe(200);
  });
});

describe("reset codes", () => {
  /** An Access of its own on the test's database, with a clock the test moves, its console kept. */
  const own = (now: () => number, logFile?: string) => {
    const lines: string[] = [];
    const a = new Access(t.db, t.services.notify, { now, logFile, log: { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) } });
    return { a, lines, code: () => /RESET CODE: (\d{6})/.exec(lines.join("\n"))?.[1] ?? "" };
  };
  const who = { ip: LAN, ua: CHROME, device: undefined, session: null };

  it("are written to the console and the log file, work once, and set the new password", async () => {
    await setPassword();
    const dir = mkdtempSync(join(tmpdir(), "afflatus-log-"));
    try {
      const log = join(dir, "logs", "afflatus.log");
      const { a, code } = own(Date.now, log);
      await a.forgot("computer", LAN);
      expect(code()).toMatch(/^\d{6}$/);
      expect(readFileSync(log, "utf8")).toContain(`password reset code: ${code()}`);
      await a.reset({ ...who, code: code(), password: "a brand new one", signOutOthers: true });
      expect(await checkPassword("a brand new one", (await readSettings(t.db)).access.password!.hash)).toBe(true);
      await expect(a.reset({ ...who, code: code(), password: "yet another one", signOutOthers: true })).rejects.toMatchObject({ statusCode: 403 });
      expect(readFileSync(log, "utf8")).toMatch(/reset code sent to this computer[\s\S]*password reset with a code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expire after 10 minutes, and one goes at most once a minute", async () => {
    await setPassword();
    let now = Date.now();
    const { a, code } = own(() => now);
    await a.forgot("computer", LAN);
    await expect(a.forgot("computer", LAN)).rejects.toMatchObject({ statusCode: 429 });
    now += 10 * 60_000 + 1;
    await expect(a.reset({ ...who, code: code(), password: "a brand new one", signOutOthers: true })).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("expired") });
  });

  it("are used up by 5 wrong entries", async () => {
    await setPassword();
    const { a, code } = own(Date.now);
    await a.forgot("computer", LAN);
    const wrong = code() === "000000" ? "111111" : "000000";
    for (let left = 4; left >= 1; left--) await expect(a.reset({ ...who, code: wrong, password: "a brand new one", signOutOthers: true })).rejects.toMatchObject({ left });
    await expect(a.reset({ ...who, code: wrong, password: "a brand new one", signOutOthers: true })).rejects.toMatchObject({ message: expect.stringContaining("used up") });
    // the right one is no good any more (and this address now waits)
    await expect(a.reset({ ...who, ip: "192.168.1.99", code: code(), password: "a brand new one", signOutOthers: true })).rejects.toMatchObject({ statusCode: 403 });
    expect(await checkPassword(PASSWORD, (await readSettings(t.db)).access.password!.hash)).toBe(true);
  });

  it("do not spend a try on a new password that is too short", async () => {
    await setPassword();
    const { a, code } = own(Date.now);
    await a.forgot("computer", LAN);
    await expect(a.reset({ ...who, code: code(), password: "short", signOutOthers: true })).rejects.toMatchObject({ statusCode: 400 });
    await a.reset({ ...who, code: code(), password: "long enough now", signOutOthers: true });
  });

  it("go to Telegram when it is set up and allowed, and Telegram is told of the change", async () => {
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
      // not set up: refused, and the page is told only This computer
      expect((await ask("POST", "/api/session/forgot", { body: { via: "telegram" } })).statusCode).toBe(409);
      expect((await ask("GET", "/api/session")).json().telegram).toBe(false);
      await writeSettings(t.db, { notify: { telegramToken: "123456789:AAE_test-token-0123456789abcdef", telegramChat: "42" } });
      expect((await ask("GET", "/api/session")).json().telegram).toBe(true);
      // every kind's tick off: the code goes all the same, it is not a notice
      await writeSettings(t.db, { notify: { events: Object.fromEntries(["renderFailed", "newDevice"].map((k) => [k, { telegram: false }])) } });
      const sent = await ask("POST", "/api/session/forgot", { body: { via: "telegram" } });
      expect(sent.statusCode).toBe(200);
      const code = /Code: (\d{6})/.exec(heard.join("\n"))?.[1];
      expect(code).toMatch(/^\d{6}$/);
      const reset = await ask("POST", "/api/session/reset", { body: { code, password: "a brand new one", signOutOthers: true } });
      expect(reset.statusCode).toBe(200);
      expect((await ask("GET", "/api/settings", { cookie: jar(reset) })).statusCode).toBe(200);
      expect(heard.at(-1)).toContain("password changed");
      // turned off in Access: Telegram is not offered
      await writeSettings(t.db, { access: { resetTelegram: false } });
      expect((await ask("GET", "/api/session")).json().telegram).toBe(false);
    } finally {
      await new Promise((r) => site.close(r));
    }
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
    // the token is in the cookie only: the database has its hash
    const token = decodeURIComponent(session.split(";")[0]!.split("=")[1]!);
    expect((await t.db.selectFrom("sessions").select("id").execute()).map((r) => r.id)).not.toContain(token);
    // Secure over https
    expect(cookie(NAMES.session, "x", { maxAgeS: null, secure: true })).toBe(`${NAMES.session}=x; Path=/; HttpOnly; SameSite=Lax; Secure`);
    expect(cookiesOf("a=1; b=%zz; c=x%20y")).toEqual({ a: "1", c: "x y" });
  });

  it("end after 12 h idle when not remembered, write their last seen at most once a minute", async () => {
    await setPassword();
    let now = Date.now();
    const a = new Access(t.db, null, { now: () => now, log: quiet });
    const g = await a.signIn({ password: PASSWORD, remember: false, ip: LAN, ua: CHROME, device: undefined });
    const seen = async () => (await t.db.selectFrom("sessions").select("last_seen_at").executeTakeFirstOrThrow()).last_seen_at;
    const first = await seen();
    now += 30_000;
    expect(await a.sessionOf(g.token, LAN)).not.toBeNull();
    expect(await seen()).toBe(first);
    now += 31_000;
    expect(await a.sessionOf(g.token, LAN)).not.toBeNull();
    expect(await seen()).not.toBe(first);
    now += IDLE_MS + 60_000;
    expect(await a.sessionOf(g.token, LAN)).toBeNull();
    // a remembered one lasts its days, used or not
    const kept = await a.signIn({ password: PASSWORD, remember: true, ip: LAN, ua: CHROME, device: undefined });
    now += 29 * 86_400_000;
    expect(await a.sessionOf(kept.token, LAN)).not.toBeNull();
    now += 2 * 86_400_000;
    expect(await a.sessionOf(kept.token, LAN)).toBeNull();
  });

  it("are listed, and signed out one by one or everywhere", async () => {
    await setPassword();
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
    // everywhere but here
    expect((await ask("POST", "/api/session/sign-out-everywhere", { cookie: mine, body: { keepThis: true } })).statusCode).toBe(200);
    expect((await ask("GET", "/api/settings", { from: "100.88.3.17", cookie: third })).statusCode).toBe(401);
    expect((await ask("GET", "/api/settings", { cookie: mine })).statusCode).toBe(200);
    // and here too
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
    // the same browser (its device cookie) signs in again: nothing new
    await signIn({ cookie: jar(first) });
    expect(notices.filter((n) => n.kind === "newDevice")).toHaveLength(1);
    await signIn({ from: "192.168.1.44", ua: IPHONE });
    expect(notices.filter((n) => n.kind === "newDevice")).toHaveLength(2);
  });

  it("goes to Telegram by default, not Discord", async () => {
    const events = (await readSettings(t.db)).notify.events.newDevice;
    expect(events).toEqual({ telegram: true, discord: false });
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
