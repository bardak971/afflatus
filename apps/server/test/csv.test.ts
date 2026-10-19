import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CostsView, SessionView } from "../src/costs";
import { csvCell, csvName, csvOf, dollars4, seconds, utc } from "../src/csv";
import { COSTS_HEADERS, costsCsv, RENDERS_HEADERS } from "../src/csvExports";
import type { Spending } from "../src/rentedBilling";
import { readSettings, updateSettings } from "../src/settings";
import { get, makeApp, type TestApp } from "./helpers";

/** The CSV files of Queue › Costs and Render times (csv.ts, csvExports.ts) and their routes. */

const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A file read back: its lines without the byte order mark, each split on its commas (none of these cells holds one). */
const linesOf = (text: string) => text.replace(/^﻿/, "").split("\r\n").filter(Boolean).map((l) => l.split(","));
/** A row of a file as a record by its header. */
const recordsOf = (text: string) => {
  const [head, ...rows] = linesOf(text);
  return rows.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ""])));
};

describe("the CSV writer", () => {
  it("quotes a cell with a comma, a quote or a line end, the quotes doubled; leaves the others bare", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a, b")).toBe('"a, b"');
    expect(csvCell('the "best"')).toBe('"the ""best"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("cr\rhere")).toBe('"cr\rhere"');
  });

  it("writes numbers with a dot, nothing for no value or a number that is none, booleans as words", () => {
    expect(csvCell(1.5)).toBe("1.5");
    expect(csvCell(-0.25)).toBe("-0.25");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell(Infinity)).toBe("");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(false)).toBe("false");
  });

  it("puts an apostrophe before a text a spreadsheet would run as a formula", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe("\"'\rx\"");
    // a number below zero is a number, not a formula
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell("RTX 4090 = fast")).toBe("RTX 4090 = fast");
  });

  it("a file: the byte order mark, then each line ended by CRLF", () => {
    expect(csvOf(["a", "b"], [[1, "x"], [null, "y, z"]])).toBe('﻿a,b\r\n1,x\r\n,"y, z"\r\n');
    expect(csvOf(["a"], [])).toBe("﻿a\r\n");
  });

  it("rounds seconds to the tenth and dollars to four decimals; times in UTC", () => {
    expect(seconds(12_345)).toBe(12.3);
    expect(seconds(null)).toBeNull();
    expect(dollars4(0.123456)).toBe(0.1235);
    expect(dollars4(undefined)).toBeNull();
    expect(utc(Date.parse("2026-10-16T09:30:00+02:00"))).toBe("2026-10-16T07:30:00.000Z");
  });

  it("names its file after its window's days, or all", () => {
    expect(csvName("costs", { from: Date.parse("2026-10-01T00:00:00Z"), to: Date.parse("2026-10-16T12:00:00Z") })).toBe("afflatus-costs-2026-10-01_2026-10-16.csv");
    expect(csvName("renders", {})).toBe("afflatus-renders-all.csv");
  });
});

// ---------------------------------------------------------------- the Costs tab's file

const session = (over: Partial<SessionView>): SessionView => ({
  id: "s", machine: "rp-a", gpu: "A40", cuda: "12.8", hostCuda: "13.2", dataCenter: "CA-MTL-1", pull: { fresh: true, bytes: 6e9, mbps: 35.14 }, bootLog: false, rate: 0.6, from: 0, to: HOUR, open: false, usd: 0.6,
  parts: { render: 30 * MIN, boot: 4 * MIN, fetch: 6 * MIN, outside: 5 * MIN, idle: 12 * MIN, failed: 3 * MIN },
  boot: { pull: MIN, packs: MIN, comfy: 2 * MIN, startFailed: 0, boot: 0 }, startFailed: null, crash: null, packs: [], estimated: [], why: "", idleMinutes: 10,
  fetched: { files: 1, bytes: 26e9 }, renders: [], ...over,
});

describe("the Costs tab's file", () => {
  const NOW = Date.parse("2026-10-16T12:00:00Z");
  const T0 = Date.parse("2026-10-16T08:00:00Z");
  const viewOf = (sessions: SessionView[]) => ({ from: T0 - HOUR, to: NOW, sessions } as unknown as CostsView);
  const storage = { volumesMonth: 1.2345678, disksMonth: 0.4, perMonth: 7, nowMonth: 7, volumes: 2, stoppedDisks: 1, unused: [] };

  it("a row per session, the oldest first, its parts in seconds; an earlier boot whole; the volumes' bill on a row of its own", async () => {
    const t = await makeApp();
    try {
      const settings = await readSettings(t.db);
      const named = { ...settings, machines: [...settings.machines, { ...settings.machines[0]!, id: "rp-a", name: "=A40 pod" }] };
      const text = costsCsv(viewOf([
        session({ id: "late", from: T0 + 2 * HOUR, to: NOW, open: true, machine: "rp-gone", boot: { pull: 0, packs: 0, comfy: 0, startFailed: 0, boot: 4 * MIN }, estimated: ["its boot: its ComfyUI never said it was up"] }),
        session({ id: "early", from: T0, to: T0 + HOUR }),
      ]), { storage } as unknown as Spending, named, NOW);
      expect(text.startsWith("﻿")).toBe(true);
      const [head] = linesOf(text);
      expect(head).toEqual([...COSTS_HEADERS]);
      const [early, late, volumes] = recordsOf(text);
      expect(early).toMatchObject({
        kind: "session", started_utc: iso(T0), ended_utc: iso(T0 + HOUR), machine: "'=A40 pod", gpu: "A40", cuda: "12.8", host_cuda: "13.2", data_center: "CA-MTL-1", rate_usd_per_hour: "0.6",
        boot_s: "240", image_pull_s: "60", image_pull_mb_per_s: "35.1", node_packs_s: "60", comfyui_start_s: "120", failed_start_s: "0", fetch_s: "360", render_s: "1800", failed_render_s: "180", outside_s: "300", idle_s: "720",
        files_fetched: "1", fetched_bytes: "26000000000", idle_stop_minutes: "10", counted_usd: "0.6", billed_usd: "",
      });
      // still running: no end; a boot from before its parts were kept: its parts empty, its whole there; a removed pod by its id
      expect(late).toMatchObject({ ended_utc: "", machine: "ComfyUI rp-gone", boot_s: "240", image_pull_s: "", node_packs_s: "", comfyui_start_s: "", failed_start_s: "", estimated: "its boot: its ComfyUI never said it was up" });
      expect(volumes).toMatchObject({ kind: "volumes", started_utc: iso(new Date(2026, 9, 1).getTime()), ended_utc: iso(NOW), volumes: "2", counted_usd: "", billed_usd: "1.2346" });
    } finally {
      await t.close();
    }
  });

  it("no volumes row for a window before this month, nor without RunPod's bill", async () => {
    const t = await makeApp();
    try {
      const settings = await readSettings(t.db);
      const before = { from: Date.parse("2026-08-01T00:00:00Z"), to: Date.parse("2026-08-31T00:00:00Z"), sessions: [] } as unknown as CostsView;
      expect(recordsOf(costsCsv(before, { storage } as unknown as Spending, settings, NOW))).toEqual([]);
      expect(recordsOf(costsCsv(viewOf([]), null, settings, NOW))).toEqual([]);
    } finally {
      await t.close();
    }
  });
});

// ---------------------------------------------------------------- the routes

describe("the CSV routes", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.close();
  });

  let n = 0;
  const render = (end: number, over: Record<string, unknown> = {}) => ({
    id: `r${n++}`, owner_id: "local", recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "illustrious", model_file: "SDXL/illustrious.safetensors", time_key: "", kind: "image" as const,
    width: 832, height: 1216, duration_ms: null, steps: 28, status: "done" as const, whole: 1, cold: 1, waited_ms: 1_500, total_ms: 20_040, load_ms: 4_000, sample_ms: 14_000, refine_ms: 0, finish_ms: 2_040,
    step_ms: 512, expected_ms: 19_000, vram_peak: 71, heat_peak: 66, asset_id: null, work: null, machine_id: "m1", gpu: "NVIDIA GeForce RTX 4090", node_ms: null, energy_wh: 1.5, power_avg_w: 270, ram_peak: null, ram_total: null,
    created_at: iso(end), ...over,
  });

  it("GET /api/renders.csv: every render of the window and filters, past the list's 500, its columns, its file's name", async () => {
    const now = Date.now();
    const from = now - 2 * HOUR;
    await updateSettings(t.db, (s) => ({ machines: s.machines.map((m) => ({ ...m, name: "@home" })), costs: { kwhPrice: 0.2, currency: "€" } }));
    const rows = Array.from({ length: 620 }, (_v, i) => render(from + 1000 + i * 1000));
    // outside the window, on another machine, failed
    rows.push(render(from - MIN));
    rows.push(render(now - MIN, { status: "failed", model_file: "=evil.safetensors", gpu: "+gpu", machine_id: "rp-a", energy_wh: null }));
    for (let i = 0; i < rows.length; i += 100) await t.db.insertInto("render_stats").values(rows.slice(i, i + 100)).execute();
    await t.db.insertInto("jobs").values({ id: rows.at(-1)!.id, owner_id: "local", recipe_id: "sdxl.text-to-picture", label: "x", inputs: "{}", status: "failed", priority: 0, error: "CUDA out of memory", created_at: iso(now), updated_at: iso(now) } as never).execute();
    await t.db.insertInto("rent_sessions").values({ id: "s1", machine_id: "rp-a", pod: "a", rate: 0.72, started_at: iso(now - HOUR), ended_at: null, seen_at: null, gpu: "NVIDIA A40", up_at: null, idle_minutes: 10, image: "ghcr.io/owner/afflatus-pod:0.1.27-cu128" }).execute();

    const res = await get(t.app, `/api/renders.csv?from=${from}&to=${now}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="afflatus-renders-${iso(from).slice(0, 10)}_${iso(now).slice(0, 10)}.csv"`);
    expect(res.body.startsWith("﻿")).toBe(true);
    expect(res.body.endsWith("\r\n")).toBe(true);
    expect(linesOf(res.body)[0]).toEqual([...RENDERS_HEADERS]);
    const records = recordsOf(res.body);
    expect(records).toHaveLength(621);
    expect(records[0]).toEqual({
      finished_utc: iso(from + 1000), status: "done", out_of_memory: "false", machine: "'@home", gpu: "NVIDIA GeForce RTX 4090", recipe: records[0]!.recipe, recipe_id: "sdxl.text-to-picture",
      model_family: "sdxl", model: "illustrious", model_file: "illustrious.safetensors", kind: "image", width: "832", height: "1216", video_length_s: "", steps: "28", cold_load: "true", cuda: "",
      total_s: "20", queue_wait_s: "1.5", load_s: "4", sampling_s: "14", refining_s: "0", finishing_s: "2", s_per_step: "0.512", expected_s: "19", vram_peak_pct: "71", gpu_temp_peak_c: "66",
      energy_wh: "1.5", power_avg_w: "270", rented_usd: "", electricity_cost: "0.0003", electricity_currency: "€",
    });
    expect(records[0]!.recipe).not.toBe("");
    // the pod's render: its cost at its session's rate, its file's name guarded, out of memory by its job's error
    expect(records.at(-1)).toMatchObject({ status: "failed", out_of_memory: "true", machine: "ComfyUI rp-a", gpu: "'+gpu", cuda: "12.8", model_file: "'=evil.safetensors", rented_usd: String(Math.round((20_040 / HOUR) * 0.72 * 10_000) / 10_000), electricity_cost: "" });

    // the tab's filters: one machine, the failed and cancelled
    expect(recordsOf((await get(t.app, `/api/renders.csv?from=${from}&to=${now}&machine=rp-a`)).body)).toHaveLength(1);
    expect(recordsOf((await get(t.app, `/api/renders.csv?from=${from}&to=${now}&only=trouble`)).body)).toHaveLength(1);
    expect(recordsOf((await get(t.app, `/api/renders.csv?from=${from}&to=${now}&recipe=wan.video`)).body)).toHaveLength(0);
    // no window: all of them, named so
    const all = await get(t.app, "/api/renders.csv");
    expect(recordsOf(all.body)).toHaveLength(622);
    expect(all.headers["content-disposition"]).toBe('attachment; filename="afflatus-renders-all.csv"');
  });

  it("GET /api/costs.csv: the window's sessions, its file's name, nothing past the window", async () => {
    const now = Date.now();
    await t.db.insertInto("rent_sessions").values([
      { id: "s1", machine_id: "rp-a", pod: "a", rate: 0.6, started_at: iso(now - 3 * HOUR), ended_at: iso(now - 2 * HOUR), seen_at: null, gpu: "NVIDIA A40", up_at: iso(now - 3 * HOUR + 4 * MIN), idle_minutes: 10 },
      { id: "s0", machine_id: "rp-a", pod: "a", rate: 0.6, started_at: iso(now - 30 * HOUR), ended_at: iso(now - 29 * HOUR), seen_at: null, gpu: "NVIDIA A40", up_at: iso(now - 30 * HOUR + 4 * MIN), idle_minutes: 10 },
    ]).execute();
    const from = now - 6 * HOUR;
    const res = await get(t.app, `/api/costs.csv?from=${from}&to=${now}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="afflatus-costs-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.body.startsWith("﻿")).toBe(true);
    const records = recordsOf(res.body);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "session", started_utc: iso(now - 3 * HOUR), ended_utc: iso(now - 2 * HOUR), gpu: "A40", boot_s: "240", outside_s: "0", idle_s: "3360", counted_usd: "0.6" });
    // the whole record: both sessions
    const all = await get(t.app, "/api/costs.csv");
    expect(recordsOf(all.body)).toHaveLength(2);
    expect(all.headers["content-disposition"]).toBe('attachment; filename="afflatus-costs-all.csv"');
  });
});
