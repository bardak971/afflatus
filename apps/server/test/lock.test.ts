import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { startFakeComfy } from "@afflatus/comfy/testing";
import { Comfy } from "../src/comfy";
import { accessOf } from "../src/lock-api";
import { readSettings } from "../src/settings";
import { get, makeApp, makeFake, post, type TestApp } from "./helpers";

/** Locking a ComfyUI to Afflatus (lock-api.ts), against the pretend ComfyUI's node pack lock. */

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await makeFake();
  fake.packVersion = "0.12.0";
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const probe = async () => (await get(t.app, "/api/machines")).json()[0] as { online: boolean; access: { state: string; canLock: boolean; local: boolean }; tokenEnd: string };
const tokenOf = async () => (await readSettings(t.db)).machines[0]!.token;

describe("locking a ComfyUI", () => {
  it("locks it, checks it took, and sends the token on every call after", async () => {
    expect((await probe()).access).toMatchObject({ state: "open", canLock: true });
    const res = await post(t.app, "/api/machines/m1/lock", {});
    expect(res.statusCode).toBe(200);
    const token = await tokenOf();
    expect(token.length).toBeGreaterThan(40);
    expect(fake.lock?.token).toBe(token);
    expect(res.json().tokenEnd).toBe(token.slice(-4));
    // the check without the token was refused, as if from another machine
    expect(fake.refused).toContain("GET /system_stats");
    // calls after go through, with the token
    const refusedBefore = fake.refused.length;
    expect((await probe()).access.state).toBe("locked");
    expect((await post(t.app, "/api/setup/rescan", {})).statusCode).toBe(200);
    expect(fake.refused.length).toBe(refusedBefore);
  });

  it("never gives the page the token, only its end; Copy token gives it on purpose", async () => {
    await post(t.app, "/api/machines/m1/lock", {});
    const token = await tokenOf();
    const settings = (await get(t.app, "/api/settings")).body;
    expect(settings).not.toContain(token);
    expect(JSON.parse(settings).machines[0].tokenEnd).toBe(token.slice(-4));
    expect((await post(t.app, "/api/machines/m1/token/copy", {})).json()).toEqual({ token });
    // never to a page on another computer (a proxy says whom it forwards for)
    expect((await t.app.inject({ method: "POST", url: "/api/machines/m1/token/copy", payload: {}, headers: { "x-forwarded-for": "192.0.2.7" } })).statusCode).toBe(403);
  });

  it("keeps the token when the page saves the machines without it, and drops it with a move to another address", async () => {
    await post(t.app, "/api/machines/m1/lock", {});
    const token = await tokenOf();
    const machines = (await get(t.app, "/api/settings")).json().machines;
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: machines.map((m: { name: string }) => ({ ...m, name: "Studio PC" })) } });
    expect(await tokenOf()).toBe(token);
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: machines.map((m: object) => ({ ...m, url: "http://127.0.0.1:1" })) } });
    expect(await tokenOf()).toBe("");
  });

  it("renews the token, and the old one is refused", async () => {
    await post(t.app, "/api/machines/m1/lock", {});
    const old = await tokenOf();
    expect((await post(t.app, "/api/machines/m1/lock", { renew: true })).statusCode).toBe(200);
    const renewed = await tokenOf();
    expect(renewed).not.toBe(old);
    expect(fake.lock?.token).toBe(renewed);
  });

  it("says locked with the wrong token, takes a pasted one only when it gets in", async () => {
    fake.lock = { token: "made-by-another-afflatus-0123456789", local: false };
    const p = await probe();
    expect(p.online).toBe(false);
    expect(p.access.state).toBe("wrong");
    expect((await post(t.app, "/api/machines/m1/token", { token: "not-the-right-one-0123456789" })).statusCode).toBe(400);
    expect((await post(t.app, "/api/machines/m1/token", { token: "made-by-another-afflatus-0123456789" })).statusCode).toBe(200);
    expect((await probe()).access.state).toBe("locked");
  });

  it("the queue tells a locked machine from an away one", async () => {
    fake.lock = { token: "made-by-another-afflatus-0123456789", local: false };
    const all = await t.services.machines();
    await all[0]!.comfy.load();
    expect(all[0]!.comfy.locked).toBe(true);
    const row = (await t.services.queue.status()).machines.find((m) => m.id === "m1");
    expect(row?.locked).toBe(true);
  });

  it("unlocks it and forgets the token", async () => {
    await post(t.app, "/api/machines/m1/lock", {});
    expect((await post(t.app, "/api/machines/m1/unlock", {})).statusCode).toBe(200);
    expect(fake.lock).toBeNull();
    expect(await tokenOf()).toBe("");
    expect((await probe()).access.state).toBe("open");
  });

  it("unlocking, or no token from its own computer, needs a sign-in of the last 10 minutes or the password (card #187)", async () => {
    const PASSWORD = "correct horse battery";
    await post(t.app, "/api/machines/m1/lock", {});
    const set = await t.app.inject({ method: "POST", url: "/api/session/password", payload: { password: PASSWORD } });
    const cookie = [set.headers["set-cookie"]].flat().map((c) => String(c).split(";")[0]).join("; ");
    // a sign-in 11 minutes old, from another computer of the network: a session kept, or stolen, long ago
    await t.db.updateTable("sessions").set({ created_at: new Date(Date.now() - 11 * 60_000).toISOString() }).execute();
    const ask = (url: string, payload: object) => t.app.inject({ method: "POST", url, remoteAddress: "192.168.1.20", headers: { cookie }, payload });
    for (const [url, body] of [["/api/machines/m1/unlock", {}], ["/api/machines/m1/lock", { local: true }]] as const) {
      const res = await ask(url, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ needPassword: true });
    }
    expect(fake.lock).toMatchObject({ local: false });
    // tightening needs nothing: a new token, or the token needed from its own computer again
    expect((await ask("/api/machines/m1/lock", { renew: true })).statusCode).toBe(200);
    expect((await ask("/api/machines/m1/unlock", { current: "wrong one" })).statusCode).toBe(403);
    expect(fake.lock).not.toBeNull();
    expect((await ask("/api/machines/m1/unlock", { current: PASSWORD })).statusCode).toBe(200);
    expect(fake.lock).toBeNull();
  });

  it("opens ComfyUI's page with a one-time code when locked, as it is when not", async () => {
    expect((await post(t.app, "/api/machines/m1/open", {})).json()).toEqual({ url: fake.url });
    await post(t.app, "/api/machines/m1/lock", {});
    const { url } = (await post(t.app, "/api/machines/m1/open", {})).json();
    expect(url).toMatch(new RegExp(`^${fake.url}/afflatus/login\\?code=`));
    expect(url).not.toContain(await tokenOf());
    // the browser lands logged in, where it was sent
    const landed = await fetch(url, { redirect: "manual" });
    expect(landed.status).toBe(302);
    expect(landed.headers.get("set-cookie")).toMatch(/HttpOnly/);
  });

  it("asks for a newer pack, and keeps the lock off, with an older one", async () => {
    fake.packVersion = "0.11.2";
    const res = await post(t.app, "/api/machines/m1/lock", {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/0\.12\.0 or newer/);
    expect(fake.lock).toBeNull();
  });

  it("with calls from this PC let in, still checks it is locked for others", async () => {
    expect((await post(t.app, "/api/machines/m1/lock", { local: true })).statusCode).toBe(200);
    expect(fake.lock?.local).toBe(true);
    expect((await probe()).access).toMatchObject({ state: "locked", local: true });
  });

  it("tells the pack the page it was locked from, the one page of this computer let in besides ComfyUI's own", async () => {
    const lock = (origin: string) => t.app.inject({ method: "POST", url: "/api/machines/m1/lock", headers: { origin }, payload: { local: true } });
    expect((await lock("http://localhost:8721")).statusCode).toBe(200);
    expect(fake.lock?.origin).toBe("http://localhost:8721");
    // what is not an origin is not passed on
    expect((await lock("http://localhost:8721/x y")).statusCode).toBe(200);
    expect(fake.lock?.origin).toBeUndefined();
  });
});

describe("ComfyUI-Manager's version", () => {
  it("is said too old below the one that closed the botnet's way in", async () => {
    const managed = await startFakeComfy({ manager: true });
    try {
      const comfy = new Comfy(managed.url, t.services.registry);
      expect((await accessOf(comfy, true, false, "0.12.0")).managerOld).toBe(false);
      managed.managerVersion = "V3.30.1";
      expect(await accessOf(comfy, true, false, "0.12.0")).toMatchObject({ manager: "3.30.1", managerOld: true });
      comfy.close();
    } finally {
      await managed.close();
    }
  });
});
