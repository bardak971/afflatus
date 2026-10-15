import { describe, expect, it } from "vitest";
import type { RentedSpending, RentedState, UpdatesView } from "../src/api";
import { billing, commandRow, commandTemplates, type CommandCtx } from "../src/bar/commandRows";
import { parseCommand, transitionsNamed } from "../src/bar/parse";
import { SETTINGS } from "../src/bar/settingsRegistry";
import { spotOf } from "../src/screens/settings/settingsIndex";

const ctx = (over: Partial<CommandCtx> = {}): CommandCtx => ({ aim: null, queue: null, selectedClip: null, bannerUndo: null, editorUndo: null, binEmpty: true, binSaid: "", ...over });
const pod = (label: string, status: RentedState["status"], running = false) => ({ id: label, label, paused: false, online: true, running, rented: { status } as RentedState });
const queue = (machines: ReturnType<typeof pod>[]) => ({ paused: false, online: true, rendering: false, running: false, waiting: 0, failed: 0, saves: 0, machines });

describe("the commands added after 0.4.0", () => {
  it("reads them in plain words", () => {
    expect(parseCommand("stop all pods")).toEqual({ cmd: "stop-all-pods" });
    expect(parseCommand("stop pods")).toEqual({ cmd: "stop-all-pods" });
    expect(parseCommand("stop pod comfy-5090")).toEqual({ cmd: "stop-pod", machine: "comfy-5090" });
    expect(parseCommand("spending")).toEqual({ cmd: "spending" });
    expect(parseCommand("balance")).toEqual({ cmd: "spending" });
    expect(parseCommand("find models wan lightning")).toEqual({ cmd: "find-models", words: "wan lightning" });
    expect(parseCommand("find models")).toEqual({ cmd: "find-models", words: "" });
    expect(parseCommand("check for updates")).toEqual({ cmd: "check-updates" });
    expect(parseCommand("updates")).toEqual({ cmd: "check-updates" });
    expect(parseCommand("update")).toEqual({ cmd: "update" });
    expect(parseCommand("go back")).toEqual({ cmd: "go-back" });
    expect(parseCommand("rollback to previous version")).toEqual({ cmd: "go-back" });
    expect(parseCommand("slow motion")).toEqual({ cmd: "slow-motion", factor: 2 });
    expect(parseCommand("slow mo 4x")).toEqual({ cmd: "slow-motion", factor: 4 });
    expect(parseCommand("slow 3")).toBeNull();
    expect(parseCommand("motion transfer in windows")).toEqual({ cmd: "motion-windows" });
    expect(parseCommand("test notification")).toEqual({ cmd: "test-notify" });
    expect(parseCommand("test telegram")).toEqual({ cmd: "test-notify", channel: "telegram" });
    expect(parseCommand("send a test notification to discord")).toEqual({ cmd: "test-notify", channel: "discord" });
  });

  it("names a transition by its label or its other words, and off by off", () => {
    expect(parseCommand("transition dissolve")).toEqual({ cmd: "transition", words: "dissolve", kind: "dissolve" });
    expect(parseCommand("transition dip black")).toEqual({ cmd: "transition", words: "dip black", kind: "dip-black" });
    expect(parseCommand("transition whiteout")).toEqual({ cmd: "transition", words: "whiteout", kind: "dip-white" });
    expect(parseCommand("transition off")).toEqual({ cmd: "transition", words: "off", kind: null });
    // several fit: none chosen, the bar lists them
    expect(parseCommand("transition wipe")).toEqual({ cmd: "transition", words: "wipe" });
    expect(transitionsNamed("wipe")).toEqual(["wipe-left", "wipe-right"]);
    expect(transitionsNamed("")).toHaveLength(10);
    expect(parseCommand("transform")).toBeNull();
  });

  it("stops every pod that bills: running or on its way up", () => {
    expect([billing({ status: "RUNNING" } as RentedState), billing({ status: "STARTING" } as RentedState), billing({ status: "EXITED" } as RentedState), billing(null)]).toEqual([true, true, false, false]);
    const x = ctx({ queue: queue([pod("a", "RUNNING", true), pod("b", "PROVISIONING"), pod("c", "EXITED")]) });
    const row = commandRow(x, { cmd: "stop-all-pods" });
    expect(row.label).toBe("Stop all pods · 2…");
    expect(row.meta).toContain("a, b");
    // offered only while one bills
    expect(commandTemplates(x).some((r) => r.key === "cmd:stop-all-pods")).toBe(true);
    expect(commandTemplates(ctx({ queue: queue([pod("c", "EXITED")]) })).some((r) => r.key === "cmd:stop-all-pods")).toBe(false);
  });

  it("says the spending against its caps, and the balance's runway", () => {
    const s = { today: 1.2, month: 14, caps: { day: 5, month: 0 }, balance: 20, lowBalance: false, spendPerHr: 0.7, runwayMs: 28 * 3_600_000, billed: true, storage: null } satisfies RentedSpending;
    const row = commandRow(ctx({ spending: s }), { cmd: "spending" });
    expect(row.label).toBe("Spending today $1.20 of $5.00");
    expect(row.meta).toContain("this month $14.00");
    expect(row.meta).not.toContain("$14.00 of");
    expect(row.meta).toContain("balance $20.00");
  });

  it("offers Update only when a newer version is out, and Go back only with one kept", () => {
    const v = (over: Partial<UpdatesView>) => ({ version: "0.4.0", newer: false, previous: null, canUpdate: true, cannot: null, here: true, latest: null, checkedAt: null, ...over }) as UpdatesView;
    const has = (x: CommandCtx, key: string) => commandTemplates(x).some((r) => r.key === key);
    expect(has(ctx({ updates: v({}) }), "cmd:update")).toBe(false);
    const out = v({ newer: true, latest: { version: "0.4.2" } as UpdatesView["latest"] });
    expect(has(ctx({ updates: out }), "cmd:update")).toBe(true);
    expect(commandRow(ctx({ updates: out }), { cmd: "update" }).label).toBe("Update to 0.4.2");
    expect(has(ctx({ updates: v({ previous: { version: "0.3.9", restoresLibrary: true } }) }), "cmd:go-back")).toBe(true);
    expect(has(ctx({ updates: v({}) }), "cmd:check-updates")).toBe(true);
  });

  it("says why a transition cannot go on the selected clip's cut", () => {
    const clip = (cutIn: "none" | "extends" | "cut") => ({ number: 3, timelineName: "Big Air", cutIn, transition: null });
    expect(commandRow(ctx({ selectedClip: clip("cut") }), { cmd: "transition", words: "dissolve", kind: "dissolve" })).toMatchObject({ label: "Clip 3: Cross dissolve on its cut", key: "cmd:transition:dissolve" });
    expect(commandRow(ctx({ selectedClip: clip("extends") }), { cmd: "transition", words: "flash", kind: "flash" }).meta).toContain("extends clip 2");
    expect(commandRow(ctx({ selectedClip: clip("none") }), { cmd: "transition", words: "off", kind: null }).meta).toContain("the first");
  });

  it("flips the other notifications and Compare in place, each on its own row of Settings", () => {
    for (const id of ["notify.renderStuck", "notify.podStopped", "notify.capReached", "notify.balanceLow", "notify.gpuFound", "notify.huntGaveUp", "notify.comfyGone", "notify.picture", "compare.result"]) {
      const s = SETTINGS.find((x) => x.id === id);
      expect(s?.kind, id).toBe("switch");
      expect(spotOf(id), id).toBeDefined();
    }
  });
});

describe("signing out, and the Costs page", () => {
  it("reads sign out for this browser, and everywhere for every device", () => {
    expect(parseCommand("sign out")).toEqual({ cmd: "sign-out" });
    expect(parseCommand("log out of this device")).toEqual({ cmd: "sign-out" });
    expect(parseCommand("sign out everywhere")).toEqual({ cmd: "sign-out-everywhere" });
    expect(parseCommand("logout all devices")).toEqual({ cmd: "sign-out-everywhere" });
    expect(parseCommand("costs")).toEqual({ cmd: "spending" });
  });

  it("offers Sign out only to a browser that holds a session, and says why not otherwise", () => {
    const has = (x: CommandCtx, key: string) => commandTemplates(x).some((r) => r.key === key);
    expect(has(ctx({ access: { locked: true, session: true } }), "cmd:sign-out")).toBe(true);
    expect(has(ctx({ access: { locked: false, session: false } }), "cmd:sign-out")).toBe(false);
    // this computer, in without the password: nothing to sign out of, everywhere still means the others
    const local = ctx({ access: { locked: true, session: false } });
    expect(has(local, "cmd:sign-out")).toBe(false);
    expect(commandRow(local, { cmd: "sign-out" }).meta).toContain("without the password");
    expect(has(local, "cmd:sign-out-everywhere")).toBe(true);
  });

  it("is the Costs page without RunPod, the day's figures with it", () => {
    expect(commandRow(ctx(), { cmd: "spending" })).toMatchObject({ label: "Costs" });
    expect(commandRow(ctx(), { cmd: "spending" }).meta).toContain("electricity");
    expect(commandTemplates(ctx()).some((r) => r.key === "cmd:spending")).toBe(true);
  });
});
