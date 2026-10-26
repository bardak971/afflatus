import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { loginId, loginsFor } from "../src/comfyLogins";
import { readSettings } from "../src/settings";
import { makeApp, makeFake, until, type TestApp } from "./helpers";

/**
 * ComfyUI logins tied to Afflatus's sign-ins (comfyLogins.ts, lock.py's logins): Open ComfyUI from a device signed in gives
 * a ComfyUI login that ends with that device's sign-in (signed out, Sign out everywhere, a new password), and the other
 * devices' logins go on. Against the pretend ComfyUI, whose lock keeps the logins as lock.py does (the lease is lock.py's
 * own tests').
 */

const PASSWORD = "correct horse battery";
const LAN = "192.168.1.20";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

let fake: FakeComfy;
let t: TestApp;
let owner = "";
beforeEach(async () => {
  fake = await makeFake();
  fake.packVersion = "0.42.0";
  t = await makeApp({ comfyUrl: fake.url });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect((await t.app.inject({ method: "POST", url: "/api/machines/m1/lock", payload: {} })).statusCode).toBe(200);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  await fake.close().catch(() => {});
});

const jar = (res: { headers: Record<string, unknown> }) => ([res.headers["set-cookie"] ?? []].flat() as string[]).map((c) => c.split(";")[0]!).filter((c) => !c.endsWith("=")).join("; ");
const ask = (method: string, url: string, cookie: string, body: unknown = {}) =>
  t.app.inject({ method: method as "POST", url, remoteAddress: LAN, headers: { "user-agent": CHROME, ...(cookie ? { cookie } : {}) }, payload: body as object });
const setPassword = async () => {
  const res = await t.app.inject({ method: "POST", url: "/api/session/password", payload: { password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  owner = jar(res);
};
const signIn = async () => jar(await ask("POST", "/api/session/sign-in", "", { password: PASSWORD, remember: true }));
const sessionsOf = async (cookie: string) => (await ask("GET", "/api/session/devices", cookie)).json().devices as Array<{ id: string; here: boolean }>;
/** Open ComfyUI from a device (its Afflatus cookies; none: this computer), and the ComfyUI cookie its browser gets by the link. */
const openFrom = async (cookie: string | null): Promise<string> => {
  const res = cookie === null ? await t.app.inject({ method: "POST", url: "/api/machines/m1/open", payload: {} }) : await ask("POST", "/api/machines/m1/open", cookie);
  expect(res.statusCode).toBe(200);
  const landed = await fetch(res.json().url, { redirect: "manual" });
  return String(landed.headers.get("set-cookie")).split(";")[0]!;
};
/** What ComfyUI answers a browser with that cookie. */
const comfyWith = async (cookie: string) => {
  const res = await fetch(`${fake.url}/system_stats`, { headers: { cookie } });
  await res.body?.cancel();
  return res.status;
};

describe("a ComfyUI login opened from Afflatus", () => {
  it("ends when its device is signed out, and the others' go on", async () => {
    await setPassword();
    const laptop = await signIn();
    const phone = await signIn();
    const fromLaptop = await openFrom(laptop);
    const fromPhone = await openFrom(phone);
    expect(fromLaptop).not.toBe(fromPhone);
    expect(await comfyWith(fromLaptop)).toBe(200);
    expect(await comfyWith(fromPhone)).toBe(200);
    // the logins ComfyUI is told of name no session: an HMAC of each under the machine's token
    const token = (await readSettings(t.db)).machines[0]!.token;
    const ids = (await sessionsOf(owner)).map((d) => d.id);
    expect(fake.logins.sort()).toEqual(ids.map((id) => loginId(token, id)).sort());
    expect(fake.logins.some((l) => ids.includes(l))).toBe(false);

    const laptopId = (await sessionsOf(laptop)).find((d) => d.here)!.id;
    expect((await ask("POST", `/api/session/devices/${laptopId}/sign-out`, owner)).statusCode).toBe(200);
    await until(async () => (await comfyWith(fromLaptop)) === 401);
    expect(await comfyWith(fromPhone)).toBe(200);
  });

  it("ends with Sign out everywhere and with a new password", async () => {
    await setPassword();
    const phone = await signIn();
    const fromPhone = await openFrom(phone);
    const fromOwner = await openFrom(owner);
    expect((await ask("POST", "/api/session/sign-out-everywhere", owner, { keepThis: true })).statusCode).toBe(200);
    await until(async () => (await comfyWith(fromPhone)) === 401);
    expect(await comfyWith(fromOwner)).toBe(200);

    const tablet = await signIn();
    const fromTablet = await openFrom(tablet);
    expect(await comfyWith(fromTablet)).toBe(200);
    const changed = await ask("POST", "/api/session/password", owner, { current: PASSWORD, password: "another horse battery", signOutOthers: true });
    expect(changed.statusCode).toBe(200);
    await until(async () => (await comfyWith(fromTablet)) === 401);
    expect(await comfyWith(fromOwner)).toBe(200);
  });

  it("opened with no password, ends when a password is set", async () => {
    const before = await openFrom(null);
    expect(await comfyWith(before)).toBe(200);
    await setPassword();
    await until(async () => (await comfyWith(before)) === 401);
    // the browser that set it is signed in, and opens it again
    expect(await comfyWith(await openFrom(owner))).toBe(200);
  });

  it("is never given for a sign-in that is not good", async () => {
    await setPassword();
    const token = (await readSettings(t.db)).machines[0]!.token;
    expect(await loginsFor(t.services.access, token, "a".repeat(64))).toBeNull();
    // with a password, "no password" opens nothing; this computer's own counts only while it needs no password
    expect(await loginsFor(t.services.access, token, "open")).toBeNull();
    expect(await loginsFor(t.services.access, token, "here")).toBeNull();
    // and a device signed out cannot open it any more
    expect((await ask("POST", "/api/machines/m1/open", "")).statusCode).toBe(401);
  });

  it("the token's login (pasted on ComfyUI's login page) is not Afflatus's to end", async () => {
    await setPassword();
    const fromOwner = await openFrom(owner);
    // a pack's cookie for the token's login, as the login form sets it (the fake makes it the same way)
    const token = (await readSettings(t.db)).machines[0]!.token;
    const pasted = `afflatus_lock_fake=token.${token.length}-${token.slice(0, 4)}`;
    expect((await ask("POST", "/api/session/sign-out-everywhere", owner, {})).statusCode).toBe(200);
    await until(async () => (await comfyWith(fromOwner)) === 401);
    expect(await comfyWith(pasted)).toBe(200);
  });
});
