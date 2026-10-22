import { describe, expect, it } from "vitest";
import type { CommandEntry, QueueStatus } from "../src/api";
import { commandTemplates, type CommandCtx } from "../src/bar/commandRows";
import { indexItems, navItems, rowsFor, type RowsData } from "../src/bar/items";
import { modeOf, parseCommand } from "../src/bar/parse";

const timeline = (id: string, label: string, updatedAt: string): CommandEntry => ({ kind: "timeline", id, label, project: null, folder: null, updatedAt, clips: 6, durationMs: 12_000, plannedMs: 12_000, exported: false, unusedTakes: 0, unusedBytes: 0 });
const draft = (id: string, label: string, updatedAt: string): CommandEntry => ({ kind: "draft", id, label, project: null, updatedAt, recipe: "sdxl", renders: 2 });

const CALM: CommandCtx = { aim: null, queue: { paused: false, online: true, rendering: false, running: false, waiting: 0, failed: 0, saves: 0, machines: [] }, selectedClip: null, bannerUndo: null, editorUndo: null, binEmpty: true, binSaid: "" };

/** The bar's rows for what is typed, with an index of two timelines and a draft, and nothing learned. */
function rows(typed: string, over: Partial<RowsData> = {}, command: Partial<CommandCtx> = {}) {
  const { mode, text } = modeOf(typed, { cast: true });
  const base = indexItems([timeline("t1", "Harbor walk", "2026-10-01T10:00:00Z"), timeline("t2", "Old pier", "2026-09-01T10:00:00Z"), draft("d1", "Night market", "2026-10-02T10:00:00Z")], [], null);
  const ctx = { ...CALM, ...command };
  return rowsFor(mode, {
    text, base, byKey: new Map(base.map((i) => [i.key, i])), templates: commandTemplates(ctx), settingRows: [], navRows: navItems([]), command: ctx,
    learn: true, ranks: {}, now: Date.parse("2026-10-10T10:00:00Z"), parsed: mode === "command" ? parseCommand(text) : null, estimateSaid: "",
    recipes: [], recipeItems: [], presetItems: [], familyOn: () => true, grid: { name: "H3", fps: 24, frames: { step: 17, offset: 5 }, size: 32 },
    queue: null, keysHere: [], barKey: "Ctrl+K", entities: [], castTo: "→ the open draft",
    ...over,
  });
}

describe("the bar's rows, mode by mode (rowsFor)", () => {
  it("lists a kind named first, the newest first, the words after it narrowing it; the New draft command still comes", () => {
    const [drafts, ...rest] = rows("draft");
    expect(drafts!.group).toBe("Drafts");
    expect(drafts!.rows.map((r) => r.key)).toEqual(["draft:d1"]);
    expect(rest.some((s) => s.rows.some((r) => r.key.startsWith("cmd:new-draft")))).toBe(true);
    expect(rows("timelines")[0]!.rows.map((r) => r.key)).toEqual(["timeline:t1", "timeline:t2"]);
    expect(rows("timeline pier")[0]!.rows.map((r) => r.key)).toEqual(["timeline:t2"]);
    // its start, typed halfway, from four letters
    expect(rows("timel")[0]!.rows.map((r) => r.key)).toEqual(["timeline:t1", "timeline:t2"]);
    expect(rows("draf")[0]!.rows.map((r) => r.key)).toEqual(["draft:d1"]);
  });

  it("with nothing typed and nothing learned, Recent lists what changed last, newest first", () => {
    const [recent, ...rest] = rows("");
    expect(recent!.group).toBe("Recent");
    expect(recent!.rows.map((r) => r.key)).toEqual(["draft:d1", "timeline:t1", "timeline:t2"]);
    expect(rest).toEqual([]);
  });

  it("suggests Resume on a paused queue and points at the failures, and leaves a learned Pause out of Recent while paused", () => {
    const sections = rows("", { ranks: { "cmd:pause": { n: 3, t: Date.parse("2026-10-10T09:00:00Z") } } }, { queue: { ...CALM.queue!, paused: true, failed: 2 } });
    expect(sections.find((s) => s.group === "Recent")!.rows.some((r) => r.key === "cmd:pause")).toBe(false);
    const suggested = sections.find((s) => s.group === "Suggested")!.rows;
    expect(suggested.map((r) => r.key)).toEqual(["cmd:resume", "suggest:queue"]);
    expect(suggested[1]!.label).toBe("2 failed in the queue");
    // running, the same learned Pause is offered first
    expect(rows("", { ranks: { "cmd:pause": { n: 3, t: Date.parse("2026-10-10T09:00:00Z") } } })[0]!.rows[0]!.key).toBe("cmd:pause");
  });

  it("a typed command comes first with its figures and the timeline it aims at, its estimate said after", () => {
    const aim = { id: "t1", name: "Harbor walk" };
    const [commands] = rows("> render clips 3-5", { estimateSaid: "about 2 min" }, { aim });
    expect(commands!.group).toBe("Commands");
    expect(commands!.rows[0]!.label).toBe("Render clips 3–5 of Harbor walk");
    expect(commands!.rows[0]!.meta).toMatch(/3 clips .* · about 2 min$/);
  });

  it("the queue mode lists the running job, the waiting ones in order, the failures, then what is done to all of them", () => {
    const job = (id: string, label: string) => ({ id, label, recipe: "sdxl", input: {}, draftId: null, createdAt: "2026-10-10T09:00:00Z" });
    const queue = {
      paused: false, online: true,
      running: { ...job("r", "Running one"), kind: "render", step: 4, steps: 20, progress: 0.2, eta: null },
      waiting: [job("w1", "First waiting"), job("w2", "Second waiting")],
      recent: [{ ...job("f", "Failed one"), status: "failed", error: "out of memory", finishedAt: null }],
    } as unknown as QueueStatus;
    const sections = rows("!", { queue }, { queue: { ...CALM.queue!, running: true, waiting: 2, failed: 1 } });
    expect(sections.map((s) => s.group)).toEqual(["Queue", "Commands"]);
    expect(sections[0]!.rows.map((r) => r.key)).toEqual(["job:r", "job:w1", "job:w2", "job:f"]);
    expect(sections[0]!.rows[0]!.meta).toBe("running · step 4 of 20");
    expect(sections[0]!.rows[2]!.meta).toMatch(/^waiting · 2nd/);
    expect(sections[1]!.rows.map((r) => r.key)).toEqual(["cmd:cancel-waiting", "cmd:retry-failed", "cmd:dismiss-failed"]);
  });

  it("searching everything puts a timeline before a command of the same words, and lights the letters found", () => {
    const sections = rows("harbor");
    expect(sections[0]!.group).toBe("Timelines");
    expect(sections[0]!.rows[0]!.ranges).toEqual([[0, 6]]);
  });

  it("the calculator reads a length on the model's grid", () => {
    const [calc] = rows("= 7s 24fps");
    expect(calc!.group).toBe("Calculator");
    expect(calc!.rows.length).toBeGreaterThan(0);
    expect(calc!.rows.every((r) => r.kind === "calc" && r.card)).toBe(true);
  });
});

describe("several ComfyUIs in the bar", () => {
  it("lists each machine's Pause, Use only and Unload as ready rows, by its name", () => {
    const machines = [
      { id: "m1", label: "Studio PC", paused: false, online: true, running: true, rented: null },
      { id: "m2", label: "Second GPU", paused: true, online: true, running: false, rented: null },
    ];
    const rows = commandTemplates({ ...CALM, queue: { ...CALM.queue!, machines } });
    const labels = rows.map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(["Pause Studio PC", "Resume Second GPU", "Use only Studio PC", "Use only Second GPU", "Unload Second GPU", "Pause all machines"]));
    // a machine that renders keeps its model: no Unload row for it
    expect(labels).not.toContain("Unload Studio PC");
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});
