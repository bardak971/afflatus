import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { holdCommand, KeepAwake, type Spawner } from "../src/keepAwake";
import { readSettings } from "../src/settings";
import { makeApp, makeFake, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * This PC kept awake while a rented pod works (card #320): asleep, it drove nothing and the pod billed until its watchdog
 * stopped it. The OS's own tool is a child held while a pod works, ended when none does and when Afflatus stops; a fake
 * spawner stands in for it here (the real one is tried by hand: powercfg /requests lists it).
 */

/** A pretend child: what was asked of it, and a way to end it as the OS would. */
function fakeSpawner() {
  const children: Array<{ cmd: string; args: readonly string[]; killed: boolean; stdinEnded: boolean; child: ChildProcess }> = [];
  const spawn: Spawner = (cmd, args) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new EventEmitter() as unknown as NonNullable<ChildProcess["stdin"]>;
    const entry = { cmd, args, killed: false, stdinEnded: false, child };
    (stdin as unknown as { end: () => void }).end = () => void (entry.stdinEnded = true);
    Object.assign(child, { stdin, kill: () => ((entry.killed = true), true) });
    children.push(entry);
    return child;
  };
  const alive = () => children.filter((c) => !c.killed);
  return { spawn, children, alive };
}

describe("the hold's command on each OS", () => {
  it("is Windows' own power request through PowerShell, systemd-inhibit on Linux, caffeinate tied to Afflatus's pid on a Mac, none elsewhere", () => {
    const win = holdCommand("win32", 42)!;
    expect(win.cmd).toBe("powershell.exe");
    const script = Buffer.from(win.args.at(-1)!, "base64").toString("utf16le");
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, never ES_DISPLAY_REQUIRED: the screen may sleep
    expect(script).toContain("SetThreadExecutionState([uint32]2147483649)");
    expect(script).toContain("[Console]::In.ReadToEnd()");
    expect(holdCommand("linux", 42)).toEqual({ cmd: "systemd-inhibit", args: expect.arrayContaining(["--what=sleep", "--mode=block", "cat"]) });
    expect(holdCommand("darwin", 42)).toEqual({ cmd: "caffeinate", args: ["-i", "-w", "42"] });
    expect(holdCommand("freebsd", 42)).toBeNull();
  });
});

describe("KeepAwake", () => {
  it("starts one child when wanted, ends it (stdin closed, killed) when not, and again at a stop", () => {
    const f = fakeSpawner();
    const awake = new KeepAwake({ platform: "win32", spawn: f.spawn });
    awake.set(true);
    awake.set(true);
    expect(f.children).toHaveLength(1);
    expect(f.children[0]!.cmd).toBe("powershell.exe");
    expect(awake.held).toBe(true);
    awake.set(false);
    expect(f.children[0]).toMatchObject({ killed: true, stdinEnded: true });
    expect(awake.held).toBe(false);
    awake.set(true);
    awake.stop();
    expect(f.alive()).toEqual([]);
    expect(awake.held).toBe(false);
  });

  it("says once why it is not held when its tool is missing, and tries again at the next ask", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeSpawner();
    const awake = new KeepAwake({ platform: "linux", spawn: f.spawn });
    awake.set(true);
    f.children[0]!.child.emit("error", Object.assign(new Error("spawn systemd-inhibit ENOENT"), { code: "ENOENT" }));
    f.children[0]!.child.emit("exit", null, null);
    expect(awake.held).toBe(false);
    expect(awake.failed).toContain("ENOENT");
    awake.set(true);
    f.children[1]!.child.emit("exit", 1, null);
    expect(warn).toHaveBeenCalledTimes(1);
    // not wanted: nothing said to have failed
    awake.set(false);
    expect(awake.failed).toBeNull();
    warn.mockRestore();
  });

  it("holds nothing on an OS with no tool for it", () => {
    const f = fakeSpawner();
    const awake = new KeepAwake({ platform: "aix", spawn: f.spawn });
    awake.set(true);
    expect(f.children).toEqual([]);
    expect(awake.held).toBe(false);
  });
});

const KEY = "rpa_test_key_0123456789";
let home: FakeComfy;
let pods: FakeComfy[];
let runpod: FakeRunpod;
let t: TestApp;
let f: ReturnType<typeof fakeSpawner>;

beforeEach(async () => {
  pods = [];
  home = await makeFake();
  runpod = await startFakeRunpod({ key: KEY, bootMs: 50, pods: [], spawn: async () => { const p = await startFakeComfy({ catalog: referenceCatalog() }); pods.push(p); return p; } });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  t.services.rented.imageCheck = async () => true;
  f = fakeSpawner();
  t.services.rented.awake = new KeepAwake({ platform: "win32", spawn: f.spawn });
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
});
afterEach(async () => {
  await t.close();
  vi.unstubAllEnvs();
  await Promise.all([home, runpod, ...pods].map((x) => x?.close().catch(() => {})));
});

async function deployed(): Promise<string> {
  const res = await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 });
  expect(res.statusCode).toBe(200);
  const id = res.json().id as string;
  await until(() => runpod.pods.some((p) => p.status === "RUNNING"));
  await until(async () => (await t.services.rented.poll(), !(await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.deployedAt));
  return id;
}
const machineOf = async (id: string) => (await readSettings(t.db)).machines.find((m) => m.id === id)!;

describe("this PC kept awake for the rented pods (card #320)", () => {
  it("is held from a deploy on, said on the pod's card, held while one of two pods works, let go with the last one", async () => {
    expect(f.children).toEqual([]);
    const a = await deployed();
    expect(t.services.rented.awake.held).toBe(true);
    expect(t.services.rented.view(await machineOf(a))?.awake).toBe("held");
    const b = await deployed();
    // one child for both pods
    expect(f.alive()).toHaveLength(1);
    expect((await post(t.app, `/api/machines/${a}/stop`, { how: "terminate" })).statusCode).toBe(200);
    await t.services.rented.poll();
    expect(t.services.rented.awake.held).toBe(true);
    expect((await post(t.app, `/api/machines/${b}/stop`, { how: "terminate" })).statusCode).toBe(200);
    await until(async () => (await t.services.rented.poll(), !t.services.rented.awake.held));
    expect(f.alive()).toEqual([]);
  });

  it("is let go when Afflatus stops, a pod still working", async () => {
    await deployed();
    expect(f.alive()).toHaveLength(1);
    t.services.rented.stop();
    expect(f.alive()).toEqual([]);
    expect(f.children[0]!.stdinEnded).toBe(true);
    // a read after the stop holds nothing again
    await t.services.rented.syncAwake();
    expect(f.alive()).toEqual([]);
  });

  it("is never held with Settings' switch off, and held again at once when it is switched back on", async () => {
    expect((await t.app.inject({ method: "PUT", url: "/api/settings", payload: { keepAwake: false } })).statusCode).toBe(200);
    const id = await deployed();
    expect(f.children).toEqual([]);
    expect(t.services.rented.view(await machineOf(id))?.awake).toBeNull();
    expect((await t.app.inject({ method: "PUT", url: "/api/settings", payload: { keepAwake: true } })).statusCode).toBe(200);
    expect(f.alive()).toHaveLength(1);
    expect((await t.app.inject({ method: "PUT", url: "/api/settings", payload: { keepAwake: false } })).statusCode).toBe(200);
    expect(f.alive()).toEqual([]);
  });

  it("is on for a new install, and its switch is in the page's settings", async () => {
    expect((await readSettings(t.db)).keepAwake).toBe(true);
    expect((await t.app.inject({ method: "GET", url: "/api/settings" })).json().keepAwake).toBe(true);
  });
});
