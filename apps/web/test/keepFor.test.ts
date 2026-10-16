import { describe, expect, it } from "vitest";
import { SETTINGS } from "../src/bar/settingsRegistry";
import { binFor, daysSaid, insteadOfWaiting, restorable, unkeepTip, unkeptMs, useKeepFor } from "../src/keepFor";
import { leftOf } from "../src/screens/library/justify";
import { expiringSaid } from "../src/screens/studio/expiring";
import { useNotify } from "../src/store";

const DAY = 24 * 60 * 60_000;

describe("how long the library waits on its own (Settings › Storage)", () => {
  it("says the days as the app says them, 0 being never", () => {
    expect([daysSaid(1), daysSaid(3), daysSaid(7), daysSaid(30)]).toEqual(["a day", "3 days", "a week", "30 days"]);
    expect(unkeptMs(1)).toBe(DAY);
    expect(unkeptMs(0)).toBeNull();
    expect(binFor(7)).toBe("a week");
    expect(binFor(0)).toBeNull();
    expect(restorable(false, 30)).toBe("for 30 days they can be restored from it");
    expect(restorable(true, 0)).toBe("it can be restored from it until it is emptied");
    expect(insteadOfWaiting(7)).toBe("after a week in the bin");
    expect(insteadOfWaiting(0)).toBe("waiting until the bin is emptied");
  });

  // review S-13: Unkeep's tip said "the one-day countdown" whatever the setting
  it("says what Unkeep does from the setting, as the server read it", () => {
    expect(unkeepTip(1)).toBe("They go to the bin by themselves in a day, counted from now");
    expect(unkeepTip(3)).toBe("They go to the bin by themselves in 3 days, counted from now");
    expect(unkeepTip(0)).toBe("They stay until you bin them: nothing goes to the bin on its own");
    useKeepFor.setState({ unkeptDays: 7 });
    expect(unkeepTip()).toBe("They go to the bin by themselves in a week, counted from now");
    useKeepFor.setState({ unkeptDays: 1 });
  });

  it("counts an unkept render down to its days, and not at all when nothing goes on its own", () => {
    const made = { createdAt: new Date(0).toISOString(), countdownFrom: null };
    expect(leftOf(made, 0, unkeptMs(3))).toBe(3 * DAY);
    expect(leftOf(made, 0, unkeptMs(0))).toBeNull();
    const sum = { from: new Date(0).toISOString(), to: new Date(DAY).toISOString() };
    expect(expiringSaid(sum, 0, unkeptMs(1))).toMatchObject({ next: "24 h" });
    expect(expiringSaid(sum, 0, unkeptMs(0))).toBeNull();
  });

  it("reads the store, a day and a week until the settings come", () => {
    expect(useKeepFor.getState()).toMatchObject({ unkeptDays: 1, binDays: 7 });
    useKeepFor.setState({ unkeptDays: 0, binDays: 30 });
    try {
      expect(unkeptMs()).toBeNull();
      expect(binFor()).toBe("30 days");
    } finally {
      useKeepFor.setState({ unkeptDays: 1, binDays: 7 });
    }
  });
});

describe("the banner when renders finish", () => {
  it("is on at first, and / flips it in place", () => {
    expect(useNotify.getState().banner).toBe(true);
    const s = SETTINGS.find((x) => x.id === "notify.banner")!;
    void s.set!({ server: undefined, save: async () => {} }, false);
    expect(useNotify.getState().banner).toBe(false);
    void s.set!({ server: undefined, save: async () => {} }, true);
    expect(useNotify.getState().banner).toBe(true);
  });

  it("offers the bin's two durations in / as choices, saved to the server as numbers", async () => {
    const saved: unknown[] = [];
    const ctx = { server: undefined, save: async (p: unknown) => void saved.push(p) };
    await SETTINGS.find((x) => x.id === "storage.unkeptDays")!.set!(ctx, "0");
    await SETTINGS.find((x) => x.id === "storage.binDays")!.set!(ctx, "30");
    expect(saved).toEqual([{ unkeptDays: 0 }, { binDays: 30 }]);
  });
});
