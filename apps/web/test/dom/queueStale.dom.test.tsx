import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { CostsView, PodSession, TimesSummary } from "../../src/api";
import { Costs } from "../../src/screens/queue/Costs";
import { RenderTimes } from "../../src/screens/queue/Times";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

/** The Costs and Render times tabs when a background refetch fails (review S-7): the figures read before stay, said as not refreshed. */

const zero = { render: 0, boot: 0, fetch: 0, packs: 0, outside: 0, idle: 0, failed: 0 };
const zeroBoot = { pull: 0, packs: 0, comfy: 0, startFailed: 0, boot: 0 };
const now = Date.now();
const costs: CostsView = {
  from: now - 30 * 86_400_000, to: now, step: 86_400_000, times: [], billed: false, billReadAt: null, runpod: false,
  month: 0, today: { usd: 0, sessions: 0, ms: 0 }, caps: { day: 0, month: 0 }, pace7: 0, storageDay: 0, monthEnd: 0, notSplit: 0,
  balance: null, runwayDays: null, spendPerHr: null, runwayNowMs: null, storage: null,
  where: { ms: zero, usd: zero, boot: { ms: zeroBoot, usd: zeroBoot }, estimated: false },
  spend: { gpus: [], values: [] }, projects: [], sessions: [], renderCosts: [], advice: [], home: [], kwh: { price: null, currency: "EUR" },
};

describe("the Costs tab", () => {
  it("keeps its figures when a refetch fails, and says they were not refreshed", async () => {
    fakeApi.on("GET /costs", costs);
    const { client } = draw(<Costs />);
    await screen.findByText(/No RunPod key: only this PC's renders are counted/);
    fakeApi.on("GET /costs", () => jsonAnswer({ error: "zz-test server away" }, 500));
    await client.refetchQueries();
    await screen.findByText(/Not refreshed since \d\d:\d\d: zz-test server away/);
    expect(screen.getByText(/No RunPod key: only this PC's renders are counted/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the error alone when nothing was ever read", async () => {
    fakeApi.on("GET /costs", () => jsonAnswer({ error: "zz-test server away" }, 500));
    draw(<Costs />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("zz-test server away"));
  });
});

describe("the Costs tab's pod sessions", () => {
  it("are sent the newest only, and every one asked for once Show all is pressed", async () => {
    const session = (i: number): PodSession => ({
      id: `zz${i}`, machine: "rp-a", gpu: "A40", cuda: null, hostCuda: null, dataCenter: null, pull: null, bootLog: false, rate: 0.6, from: now - (i + 1) * 3_600_000, to: now - (i + 1) * 3_600_000 + 600_000,
      open: false, usd: 0.1, parts: { ...zero, idle: 600_000 }, boot: zeroBoot, startFailed: null, crash: null, packs: [], estimated: [], why: "", idleMinutes: 10, fetched: { files: 0, bytes: 0 }, renders: [],
    } as unknown as PodSession);
    const all = Array.from({ length: 30 }, (_, i) => session(i));
    // the handler sees the path without its query: the request just logged says what was asked
    fakeApi.on("GET /costs", () => (fakeApi.calls("GET", "/costs").at(-1)!.path.includes("sessions=all") ? { ...costs, runpod: true, sessions: all } : { ...costs, runpod: true, sessions: all.slice(0, 12), sessionsAll: { count: 30, longestMs: 600_000 } }));
    draw(<Costs />);
    fireEvent.click(await screen.findByRole("button", { name: "Show all 30" }));
    await waitFor(() => expect(screen.getAllByText(/^A40/).length).toBeGreaterThanOrEqual(30));
    const asked = fakeApi.calls("GET", "/costs");
    expect(asked.filter((a) => a.path.includes("sessions=all"))).toHaveLength(1);
    expect(asked[0]!.path).not.toContain("sessions=all");
  });

  it("are not all read again each minute once shown (P6): the newest come with the tab's own read, over the ones read before", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let gpu = "A40";
      const session = (i: number): PodSession => ({
        id: `zz${i}`, machine: "rp-a", gpu: i === 0 ? gpu : "A40", cuda: null, hostCuda: null, dataCenter: null, pull: null, bootLog: false, rate: 0.6, from: now - (i + 1) * 3_600_000, to: now - (i + 1) * 3_600_000 + 600_000,
        open: false, usd: 0.1, parts: { ...zero, idle: 600_000 }, boot: zeroBoot, startFailed: null, crash: null, packs: [], estimated: [], why: "", idleMinutes: 10, fetched: { files: 0, bytes: 0 }, renders: [],
      } as unknown as PodSession);
      const all = () => Array.from({ length: 30 }, (_, i) => session(i));
      fakeApi.on("GET /costs", () => (fakeApi.calls("GET", "/costs").at(-1)!.path.includes("sessions=all") ? { ...costs, runpod: true, sessions: all() } : { ...costs, runpod: true, sessions: all().slice(0, 12), sessionsAll: { count: 30, longestMs: 600_000 } }));
      draw(<Costs />);
      fireEvent.click(await screen.findByRole("button", { name: "Show all 30" }));
      await waitFor(() => expect(screen.getAllByText(/^A40/).length).toBe(30));
      // the newest session changes; a minute and a half later the tab has read its head again, never every session
      gpu = "zz-test H100";
      await vi.advanceTimersByTimeAsync(90_000);
      await waitFor(() => expect(screen.getAllByText(/^zz-test H100/)).toHaveLength(1));
      expect(screen.getAllByText(/^A40/)).toHaveLength(29);
      const asked = fakeApi.calls("GET", "/costs");
      expect(asked.filter((a) => a.path.includes("sessions=all"))).toHaveLength(1);
      expect(asked.filter((a) => !a.path.includes("sessions=all")).length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

const tiles = {
  done: 0, images: 0, videos: 0, failed: 0, cancelled: 0, videoMs: 0, lostMs: 0, gpuMs: 0, longestMs: 0, loadMs: 0, loads: 0, loadUsualMs: null,
  waitedUsualMs: null, waitedSlowMs: null, off: null, vramPeak: null, vramUsual: null, heatPeak: null, heatUsual: null,
};
const times: TimesSummary = {
  period: "week", from: now - 7 * 86_400_000, to: now, step: 86_400_000, times: [], buckets: [], keepDays: 30, since: null, spanMs: 7 * 86_400_000, tiles,
  finished: { images: [], videos: [], bad: [] }, phases: { loading: [], sampling: [], refining: [], finishing: [] },
  wait: { usual: [], slow: [] }, gpu: { vram: [], heat: [] }, models: [],
};

describe("the Render times tab", () => {
  it("keeps its figures when a refetch fails, and says they were not refreshed", async () => {
    fakeApi.on("GET /renders/summary", times);
    const { client } = draw(<RenderTimes />);
    await screen.findByText("No render history yet");
    fakeApi.on("GET /renders/summary", () => jsonAnswer({ error: "zz-test server away" }, 500));
    await client.refetchQueries({ queryKey: ["renders", "summary"] });
    await screen.findByText(/Not refreshed since \d\d:\d\d: zz-test server away/);
    expect(screen.getByText("No render history yet")).toBeTruthy();
  });
});
