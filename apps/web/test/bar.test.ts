import { describe, expect, it } from "vitest";
import { castPlace, clipRefuses, withPerson, type ClipCast } from "../src/bar/castTo";
import { atTop } from "../src/screens/queue/order";
import { gridAtLeast } from "@afflatus/core";
import { arithmetic, calc, ratioOf, sizeFor, type Grid } from "../src/bar/calc";
import { draftModels, indexItems, lowerFirst, navItems, timelineLength, usedItems, withItems } from "../src/bar/items";
import { snapEdge } from "../src/fields/SizeField";
import { useBanners, useNotify } from "../src/store";
import { highlight, pieces, prepare, QUALITY, score, search } from "../src/bar/match";
import { clipList, COMMANDS, modeOf, parseCommand, sizeOf } from "../src/bar/parse";
import { bonus, bumped, frecency, HALF_LIFE_MS, KEPT, recentKeys, renamed } from "../src/bar/rank";
import { PAGES, SETTINGS, settingKeyNow } from "../src/bar/settingsRegistry";
import { settingHref } from "../src/screens/settings/settingsIndex";
import { insertSnippet, slugOf, snippetsFor, typedTrigger } from "../src/bar/snippets";

const H3: Grid = { name: "H3", fps: 24, frames: { step: 17, offset: 5 }, size: 32 };

describe("matching", () => {
  const p = prepare("Harbor walk");
  it("finds the label from its start first, then a word's start, then inside", () => {
    expect(score(p, "harbor")).toBeGreaterThan(score(p, "walk"));
    expect(score(p, "walk")).toBeGreaterThan(score(p, "arbor"));
    expect(score(p, "harbor walk")).toBeGreaterThan(score(p, "harbor"));
  });
  it("finds a label by its words' initials", () => {
    expect(score(p, "hw")).toBeGreaterThan(QUALITY.initials - 100);
    expect(highlight(p, "hw")).toEqual([[0, 1], [7, 8]]);
  });
  it("finds the letters in order, from the start of a word, and not otherwise", () => {
    expect(score(p, "hrbwk")).toBeGreaterThan(0);
    expect(score(p, "hrbwk")).toBeLessThan(QUALITY.initialsInside - 100);
    expect(score(p, "rbw")).toBe(0);
    expect(score(p, "xyz")).toBe(0);
    expect(score(prepare("Prompt history in the bar command bar quote prompts"), "harbor")).toBe(0);
  });
  it("finds several words anywhere", () => {
    expect(score(prepare("Night market 04"), "mar nig")).toBeGreaterThan(0);
    expect(highlight(prepare("Night market 04"), "mar nig")).toEqual([[0, 3], [6, 9]]);
  });
  it("prefers the shorter label for the same match", () => {
    expect(score(prepare("Harbor walk"), "harbor")).toBeGreaterThan(score(prepare("Harbor walk · c2 · t3"), "harbor"));
  });
  it("cuts the label into plain and matched parts", () => {
    expect(pieces("Harbor walk", highlight(p, "walk"))).toEqual([{ text: "Harbor ", hit: false }, { text: "walk", hit: true }]);
    expect(pieces("Harbor walk", highlight(p, "hw")).filter((x) => x.hit).map((x) => x.text)).toEqual(["H", "w"]);
  });
  it("keeps the best few, the learned rank added", () => {
    const items = ["Harbor walk", "Harbor walk · c2 · t3", "Night market", "Hollow wood"].map((label) => ({ label, p: prepare(label) }));
    expect(search(items, "hw", 10).map((x) => x.item.label)).toEqual(["Harbor walk", "Hollow wood", "Harbor walk · c2 · t3"]);
    // used every day: it comes first among matches of the same kind
    const used = search(items, "hw", 10, (x) => (x.label === "Hollow wood" ? 50 : 0));
    expect(used[0]!.item.label).toBe("Hollow wood");
    expect(search(items, "hw", 1)).toHaveLength(1);
    expect(search(items, "", 2)).toHaveLength(2);
  });
  it("answers a keystroke over 10 000 entries well within a frame", () => {
    const words = ["harbor", "walk", "night", "market", "rooftop", "chase", "neon", "rain", "alley", "studio", "portrait", "take", "clip", "draft"];
    let seed = 7;
    const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const labels = Array.from({ length: 10_000 }, (_, i) => `${words[Math.floor(rnd() * words.length)]} ${words[Math.floor(rnd() * words.length)]} ${i % 7 ? `c${i % 9} · t${i % 5}` : String(i).padStart(2, "0")}`);
    const t0 = performance.now();
    const items = labels.map((label) => ({ p: prepare(label) }));
    const prepared = performance.now() - t0;
    const times: number[] = [];
    for (const q of ["h", "hw", "harbor", "nmk", "rooftop chase", "zzz", "c3 t2", "ra"]) {
      const t = performance.now();
      search(items, q, 50);
      times.push(performance.now() - t);
    }
    const worst = Math.max(...times);
    // the budget is 16 ms a keystroke; the test allows a slow CI runner three times that
    console.log(`bar matching, 10 000 entries: prepared once in ${prepared.toFixed(1)} ms; per keystroke ${times.map((x) => x.toFixed(2)).join(", ")} ms (worst ${worst.toFixed(2)} ms)`);
    expect(worst).toBeLessThan(50);
  });
});

describe("learned rank", () => {
  const now = 1_000_000_000_000;
  it("counts uses, worn down by time", () => {
    let r = bumped({}, "timeline:a", now);
    r = bumped(r, "timeline:a", now);
    expect(frecency(r["timeline:a"], now)).toBeCloseTo(2);
    expect(frecency(r["timeline:a"], now + HALF_LIFE_MS)).toBeCloseTo(1);
    expect(bonus(r["timeline:a"], now)).toBeGreaterThan(bonus(r["timeline:a"], now + 4 * HALF_LIFE_MS));
    expect(bonus(undefined, now)).toBe(0);
  });
  it("lists the last used first and keeps a bounded number", () => {
    let r = bumped({}, "a", now);
    r = bumped(r, "b", now + 1);
    expect(recentKeys(r, 5)).toEqual(["b", "a"]);
    for (let i = 0; i < KEPT + 20; i++) r = bumped(r, `k${i}`, now + 10 + i);
    expect(Object.keys(r).length).toBe(KEPT);
  });
  it("keeps what was learned of a result whose key changed", () => {
    const r = renamed({ "set:page.storage.Back up now": { n: 3, t: now }, "timeline:a": { n: 1, t: now } }, settingKeyNow);
    expect(r).toEqual({ "set:storage.backup": { n: 3, t: now }, "timeline:a": { n: 1, t: now } });
    expect(renamed({ a: { n: 1, t: now }, b: { n: 2, t: now + 5 } }, () => "c")).toEqual({ c: { n: 3, t: now + 5 } });
  });
});

describe("a setting picked in the bar", () => {
  it("lands on its own row of Settings, whichever it is", () => {
    for (const s of [...SETTINGS, ...PAGES]) expect(settingHref(s.id, s.page), s.id).toMatch(/\?find=/);
    expect(settingHref("theme.night")).toBe("/settings/interface?find=interface.theme");
    expect(settingHref("comfy.url")).toBe("/settings?find=comfy.url");
  });
  // the page says "Blocked by the browser" under the switch; the bar has no row for it, and once stayed silent
  it("says so when the browser refuses notifications, and leaves the switch off", async () => {
    const was = (globalThis as { Notification?: unknown }).Notification;
    (globalThis as { Notification?: unknown }).Notification = { permission: "denied" };
    try {
      const each = SETTINGS.find((s) => s.id === "notify.renderDone")!;
      await each.set!({ server: undefined, save: async () => {} }, true);
      expect(useNotify.getState().browser.renderDone).toBeFalsy();
      expect(useBanners.getState().items.find((b) => b.id === "bar:notify")).toMatchObject({ tone: "bad", href: "/settings/interface?find=notify.renderDone" });
    } finally {
      (globalThis as { Notification?: unknown }).Notification = was;
    }
  });
});

describe("modes and commands", () => {
  it("picks the mode from the first character", () => {
    expect(modeOf("> seed 4")).toEqual({ mode: "command", text: "seed 4" });
    expect(modeOf("#dev")).toEqual({ mode: "place", text: "dev" });
    expect(modeOf("/ hover")).toEqual({ mode: "setting", text: "hover" });
    expect(modeOf("= 7s")).toEqual({ mode: "calc", text: "7s" });
    expect(modeOf("!")).toEqual({ mode: "queue", text: "" });
    expect(modeOf("harbor ")).toEqual({ mode: "all", text: "harbor" });
    // the optional modes only when they are on
    expect(modeOf('"rain', { history: false, cast: false }).mode).toBe("all");
    expect(modeOf("@ada", { history: false, cast: true }).mode).toBe("cast");
  });
  it("reads clip numbers", () => {
    expect(clipList("3-5")).toEqual([3, 4, 5]);
    expect(clipList("5 – 3")).toEqual([3, 4, 5]);
    expect(clipList("2, 7 4")).toEqual([2, 4, 7]);
    expect(clipList("3 to 4")).toEqual([3, 4]);
    expect(clipList("three")).toBeNull();
    expect(clipList("1-1000")).toBeNull();
  });
  it("reads each command with its figures", () => {
    expect(parseCommand("render clips 3-5")).toEqual({ cmd: "render-clips", clips: [3, 4, 5] });
    expect(parseCommand("Render clip 2")).toEqual({ cmd: "render-clips", clips: [2] });
    expect(parseCommand("render 1,2")).toEqual({ cmd: "render-clips", clips: [1, 2] });
    expect(parseCommand("render missing")).toEqual({ cmd: "render-missing" });
    expect(parseCommand("export")).toEqual({ cmd: "export" });
    expect(parseCommand("seed 1234")).toEqual({ cmd: "seed", value: 1234 });
    expect(parseCommand("seed 99999999999")).toBeNull();
    expect(parseCommand("steps 30")).toEqual({ cmd: "steps", value: 30 });
    expect(parseCommand("steps 2.5")).toBeNull();
    expect(parseCommand("cfg 4,5")).toEqual({ cmd: "cfg", value: 4.5 });
    expect(parseCommand("size 576x1024")).toEqual({ cmd: "size", width: 576, height: 1024 });
    expect(parseCommand("size 576 × 1024")).toEqual({ cmd: "size", width: 576, height: 1024 });
    expect(parseCommand("length 5s")).toEqual({ cmd: "length", seconds: 5 });
    expect(parseCommand("length 7.5 seconds")).toEqual({ cmd: "length", seconds: 7.5 });
    expect(parseCommand("load H3")).toEqual({ cmd: "load", model: "H3" });
    expect(parseCommand("new draft klein")).toEqual({ cmd: "new-draft", recipe: "klein" });
    expect(parseCommand("pause queue")).toEqual({ cmd: "pause" });
    expect(parseCommand("resume")).toEqual({ cmd: "resume" });
    // one ComfyUI of several, by its name; "all" is every one
    expect(parseCommand("pause all")).toEqual({ cmd: "pause" });
    expect(parseCommand("pause Studio PC")).toEqual({ cmd: "pause", machine: "Studio PC" });
    expect(parseCommand("resume second gpu")).toEqual({ cmd: "resume", machine: "second gpu" });
    expect(parseCommand("use only Second GPU")).toEqual({ cmd: "use-only", machine: "Second GPU" });
    // the Load a model panel, on a machine or not; a model by its name is still the load of that model
    expect(parseCommand("load a model")).toEqual({ cmd: "load-panel" });
    expect(parseCommand("load a model on Second GPU")).toEqual({ cmd: "load-panel", machine: "Second GPU" });
    expect(parseCommand("load h3")).toEqual({ cmd: "load", model: "h3" });
    // one machine's views, and every machine's panel
    expect(parseCommand("log second gpu")).toEqual({ cmd: "machine-log", machine: "second gpu" });
    expect(parseCommand("comfyui log of Studio PC")).toEqual({ cmd: "machine-log", machine: "Studio PC" });
    expect(parseCommand("open comfyui")).toEqual({ cmd: "open-comfy" });
    expect(parseCommand("open comfyui on Garage PC")).toEqual({ cmd: "open-comfy", machine: "Garage PC" });
    expect(parseCommand("open comfy of second gpu")).toEqual({ cmd: "open-comfy", machine: "second gpu" });
    expect(parseCommand("render times garage")).toEqual({ cmd: "machine-times", machine: "garage" });
    expect(parseCommand("models on second gpu")).toEqual({ cmd: "machine-models", machine: "second gpu" });
    expect(parseCommand("comfyuis")).toEqual({ cmd: "machines" });
    expect(parseCommand("show the machines")).toEqual({ cmd: "machines" });
    expect(parseCommand("generate on second gpu")).toEqual({ cmd: "generate", machine: "second gpu" });
    expect(parseCommand("generate")).toEqual({ cmd: "generate" });
    expect(parseCommand("render missing on second gpu")).toEqual({ cmd: "render-missing", machine: "second gpu" });
    expect(parseCommand("render clips 3-5 on studio")).toEqual({ cmd: "render-clips", clips: [3, 4, 5], machine: "studio" });
    expect(parseCommand("render missing")).toEqual({ cmd: "render-missing" });
    expect(parseCommand("unload garage")).toEqual({ cmd: "unload", machine: "garage" });
    expect(parseCommand("empty the bin")).toEqual({ cmd: "empty-bin" });
    expect(parseCommand("bin unused takes")).toEqual({ cmd: "bin-unused" });
    expect(parseCommand("link folder D:\\shoots")).toEqual({ cmd: "link-folder", path: "D:\\shoots" });
    expect(parseCommand("link folder")).toEqual({ cmd: "link-folder", path: "" });
    expect(parseCommand("new project Harbor")).toEqual({ cmd: "new-project", name: "Harbor" });
    expect(parseCommand("split")).toEqual({ cmd: "split" });
    expect(parseCommand("split clip at the playhead")).toEqual({ cmd: "split" });
    expect(parseCommand("prev take")).toEqual({ cmd: "previous-take" });
    expect(parseCommand("next take")).toEqual({ cmd: "next-take" });
    expect(parseCommand("cancel all waiting")).toEqual({ cmd: "cancel-waiting" });
    expect(parseCommand("retry failed")).toEqual({ cmd: "retry-failed" });
    expect(parseCommand("dismiss all failed jobs")).toEqual({ cmd: "dismiss-failed" });
    expect(parseCommand("group the queue by model")).toEqual({ cmd: "group-queue" });
    expect(parseCommand("render")).toBeNull();
    expect(parseCommand("make it pop")).toBeNull();
  });
  it("reads the commands that reach the queue page, the editor, the Workflows screen and the Prompt kit", () => {
    expect(parseCommand("unload models")).toEqual({ cmd: "unload" });
    expect(parseCommand("free vram")).toEqual({ cmd: "unload" });
    expect(parseCommand("generate")).toEqual({ cmd: "generate" });
    expect(parseCommand("render missing on second gpu")).toEqual({ cmd: "render-missing", machine: "second gpu" });
    expect(parseCommand("render clips 3-5 on studio")).toEqual({ cmd: "render-clips", clips: [3, 4, 5], machine: "studio" });
    expect(parseCommand("render missing")).toEqual({ cmd: "render-missing" });
    expect(parseCommand("new timeline")).toEqual({ cmd: "new-timeline", name: "" });
    expect(parseCommand("new timeline Harbor cut")).toEqual({ cmd: "new-timeline", name: "Harbor cut" });
    expect(parseCommand("new folder shots")).toEqual({ cmd: "new-folder", name: "shots" });
    expect(parseCommand("new folder")).toBeNull();
    expect(parseCommand("import workflow")).toEqual({ cmd: "import-workflow" });
    // a rented GPU: the dialog, or the last one again (its rate asked first)
    expect(parseCommand("deploy gpu")).toEqual({ cmd: "deploy-gpu" });
    expect(parseCommand("rent a gpu")).toEqual({ cmd: "deploy-gpu" });
    expect(parseCommand("deploy again")).toEqual({ cmd: "deploy-again" });
    expect(parseCommand("finish")).toEqual({ cmd: "finish" });
    expect(parseCommand("fix all")).toEqual({ cmd: "fix-all" });
    expect(parseCommand("view last render")).toEqual({ cmd: "view-last" });
    expect(parseCommand("last render")).toEqual({ cmd: "view-last" });
    expect(parseCommand("reconnect")).toEqual({ cmd: "reconnect" });
    expect(parseCommand("new person Ada")).toEqual({ cmd: "new-person", name: "Ada" });
    expect(parseCommand("New Snippet Cine look")).toEqual({ cmd: "new-snippet", name: "Cine look" });
    expect(parseCommand("preset night street")).toEqual({ cmd: "preset", name: "night street" });
    expect(parseCommand("save as preset Night street")).toEqual({ cmd: "save-preset", name: "Night street" });
    // a template that needs nothing more is ready as it is typed
    for (const c of COMMANDS.filter((x) => !x.needs)) expect(parseCommand(c.typed)?.cmd, c.id).toBe(c.id);
  });
  it("reads a size", () => {
    expect(sizeOf("1152x2048")).toEqual({ width: 1152, height: 2048 });
    expect(sizeOf("big")).toBeNull();
  });
});

describe("calculator", () => {
  it("gives the frames of a length on the model's grid", () => {
    expect(gridAtLeast(168, H3.frames)).toBe(175);
    const c = calc("7s 24fps", H3)!;
    expect(c[0]!.value).toBe("175");
    expect(c[0]!.note).toContain("7.29 s");
    expect(c[0]!.copy).toBe("175");
  });
  it("gives the length of a number of frames", () => {
    const c = calc("121f 24fps", H3)!;
    expect(c[0]!.value).toBe("5.04 s");
    expect(c[1]!.value).toBe("124 f");
    expect(calc("175 frames", H3)![1]!.value).toBe("yes");
  });
  it("gives the pixels and proportions of a size", () => {
    const c = calc("1152x2048", H3)!;
    expect(c[0]!.value).toBe("2.4 MP");
    expect(c[0]!.note).toContain("9:16");
    expect(calc("1000x1000", H3)![1]!.value).toBe("992×992");
    expect(ratioOf(1920, 1080)).toBe("16:9");
    expect(ratioOf(1366, 768)).toBe("≈ 16:9");
  });
  it("gives a size from proportions and megapixels, snapped to the grid", () => {
    expect(calc("9:16 1mp", H3)![0]!.value).toBe("768×1344");
    expect(sizeFor(16, 9, 1e6, 32)).toEqual({ width: 1344, height: 768 });
    expect(calc("1:1", H3)![0]!.value).toBe("992×992");
  });
  it("does plain sums and nothing else", () => {
    expect(arithmetic("2*(3+4)")).toBe(14);
    expect(arithmetic("17*10+5")).toBe(175);
    expect(arithmetic("2^10")).toBe(1024);
    expect(arithmetic("1/0")).toBeNull();
    expect(arithmetic("alert(1)")).toBeNull();
    expect(arithmetic("(1+2")).toBeNull();
    expect(calc("hello", H3)).toBeNull();
    expect(calc("", H3)).toBeNull();
  });
  // the calculator's own example chip: a sum with a ×, not a frame of 17×10 with "+5" left over
  it("reads a sum with * as a sum, and a size only when it is all that is typed", () => {
    expect(calc("17*10+5", H3)![0]).toMatchObject({ label: "result", value: "175" });
    expect(calc("2*3", H3)![0]!.label).toBe("result");
    expect(calc("1152*2048", H3)![0]!.value).toBe("2.4 MP");
    expect(calc(" 832 x 1216 ", H3)![0]!.value).toBe("1.0 MP");
  });
});

describe("the footer's words for an action", () => {
  it("lowers the first letter and keeps names written with capitals", () => {
    expect(lowerFirst("Show in Projects")).toBe("show in Projects");
    expect(lowerFirst("Render, at the top of the queue")).toBe("render, at the top of the queue");
    expect(lowerFirst("ComfyUI log")).toBe("ComfyUI log");
    expect(lowerFirst("CFG 4")).toBe("CFG 4");
    expect(lowerFirst("")).toBe("");
  });
});

describe("a size set from the bar", () => {
  // as the size field keeps a typed edge: on the grid, within the least and most (`> size 12x12` once wrote 12×12)
  const spec = { grid: 8, min: 256, max: 2048 };
  it("puts each edge on the recipe's grid, within its least and most", () => {
    expect(snapEdge(spec, 12)).toBe(256);
    expect(snapEdge(spec, 9999)).toBe(2048);
    expect(snapEdge(spec, 835)).toBe(832);
    expect(snapEdge(spec, 1216)).toBe(1216);
  });
});

describe("snippets", () => {
  const list = [{ name: "Cine look", text: "Live-action, cinematic" }, { name: "Night", text: "Night exterior, wet streets" }, { name: "Night rain", text: "Rain at night" }];
  it("makes a name a slug", () => {
    expect(slugOf("Cine look")).toBe("cine-look");
    expect(slugOf("  Été / pluie!! ")).toBe("ete-pluie");
  });
  // as SnippetKeys puts one in: the ;word before the cursor, replaced by the snippet the box picked
  const put = (text: string, caret: number, s: { text: string }) => insertSnippet(text, typedTrigger(text, caret)!.start, caret, s.text);
  it("puts a snippet in for the ;name before the cursor", () => {
    expect(typedTrigger("A harbor ;cine-look", 19)).toEqual({ word: "cine-look", start: 9 });
    expect(put("A harbor ;cine-look", 19, list[0]!)).toEqual({ text: "A harbor Live-action, cinematic", caret: 31 });
    expect(put(";night", 6, list[1]!)).toEqual({ text: "Night exterior, wet streets", caret: 27 });
    expect(put("x ;cine-look and more", 12, list[0]!)).toEqual({ text: "x Live-action, cinematic and more", caret: 24 });
  });
  it("leaves alone what is no snippet", () => {
    expect(typedTrigger("a;cine-look", 11)).toBeNull();
    expect(snippetsFor("nope", list)).toEqual([]);
    expect(typedTrigger(";", 1)).toEqual({ word: "", start: 0 });
    expect(typedTrigger("plain", 5)).toBeNull();
  });
  it("offers the snippets a ;word starts, the exact one first", () => {
    expect(typedTrigger("rain ;ni", 8)).toEqual({ word: "ni", start: 5 });
    expect(typedTrigger("rain;ni", 7)).toBeNull();
    expect(snippetsFor("night", list).map((s) => s.name)).toEqual(["Night", "Night rain"]);
    expect(snippetsFor("", list)).toHaveLength(3);
  });
});

describe("a render sent to the top of the queue", () => {
  it("puts its jobs first, in the order they wait in, and leaves out one no longer waiting", () => {
    expect(atTop(["w1", "w2", "j1", "w3", "j2"], ["j1", "j2"])).toEqual(["j1", "j2", "w1", "w2", "w3"]);
    expect(atTop(["w1", "j2", "j1"], ["j1", "j2"])).toEqual(["j2", "j1", "w1"]);
    expect(atTop(["w1", "j2"], ["j1", "j2"])).toEqual(["j2", "w1"]);
    expect(atTop([], ["j1"])).toEqual([]);
  });
});

describe("where @name puts a person", () => {
  const recipe = (inputs: NonNullable<ClipCast["recipe"]>["inputs"]) => ({ title: "Video model", inputs });
  const clip = (over: Partial<ClipCast> = {}): ClipCast => ({
    timelineName: "Harbor walk", number: 3, kind: "video", recipe: recipe([{ type: "prompt" }, { type: "references", roles: ["person", "place"] }]), look: null, ...over,
  });
  it("goes to the selected clip when its model takes a person: references, a voice or a prompt", () => {
    expect(castPlace(clip())).toEqual({ to: "clip", why: null, detail: "→ clip 3 of Harbor walk" });
    expect(castPlace(clip({ recipe: recipe([{ type: "audio", role: "voice" }]) })).to).toBe("clip");
    expect(castPlace(clip({ recipe: recipe([{ type: "references", roles: ["person"] }]) })).to).toBe("clip");
  });
  it("goes to the open draft without a selected clip, or when the clip cannot take one, saying why", () => {
    expect(castPlace(null)).toEqual({ to: "draft", why: null, detail: "→ the open draft" });
    expect(castPlace(clip({ kind: "still" })).detail).toBe("→ the open draft · clip 3 is a still picture");
    expect(clipRefuses(clip({ recipe: null }))).toMatch(/no model/);
    expect(clipRefuses(clip({ recipe: recipe([{ type: "image" }, { type: "references", media: "video", roles: ["person"] }, { type: "audio", role: "sound" }]) }))).toMatch(/Video model, takes no person/);
    expect(clipRefuses(clip({ recipe: recipe([{ type: "references", roles: ["style"] }]) }))).toMatch(/takes no person/);
    const full = { cast: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}` })), style: null };
    expect(castPlace(clip({ look: full })).to).toBe("draft");
  });
  it("adds the person at the end of a cast, once", () => {
    expect(withPerson(null, "p1")).toEqual({ cast: [{ id: "p1" }], style: null, snippets: [] });
    const look = { cast: [{ id: "p1", outfit: "o1" }], style: "s1", snippets: ["n1"] };
    expect(withPerson(look, "p2")).toEqual({ cast: [{ id: "p1", outfit: "o1" }, { id: "p2" }], style: "s1", snippets: ["n1"] });
    expect(withPerson(look, "p1")).toBeNull();
  });
});

describe("a timeline's length in the bar", () => {
  it("says what is rendered of the length the editor plans, one figure when they read the same", () => {
    expect(timelineLength({ durationMs: 12_000, plannedMs: 42_200 })).toBe("0:12 rendered of 0:42");
    expect(timelineLength({ durationMs: 42_000, plannedMs: 42_000 })).toBe("0:42");
    expect(timelineLength({ durationMs: 42_000, plannedMs: 42_300 })).toBe("0:42");
  });
  it("puts it on the timeline's row", () => {
    const [row] = indexItems([{
      kind: "timeline", id: "t1", label: "Harbor walk", project: null, folder: null, updatedAt: "2026-10-08T00:00:00.000Z",
      clips: 3, durationMs: 12_000, plannedMs: 42_200, exported: false, unusedTakes: 0, unusedBytes: 0,
    }], [], null);
    expect(row!.meta).toBe("Timeline · 3 clips · 0:12 rendered of 0:42 · Inbox");
  });
});

describe("a draft's row in the bar", () => {
  const draft = { kind: "draft" as const, id: "d1", label: "Sunflower field", project: null, updatedAt: new Date().toISOString(), recipe: "krea2.txt2img", renders: 4, models: ["zimage", "krea2"] };
  const recipes = [{ id: "krea2.txt2img", title: "txt2img", family: "krea2" }] as unknown as Parameters<typeof indexItems>[1];
  const families = [{ id: "krea2", name: "Krea 2" }, { id: "zimage", name: "Z-Image" }];
  it("says every model it was tried on, its form's first, and is found by any of them", () => {
    const [row] = indexItems([draft], recipes, null, undefined, families);
    expect(row!.meta).toMatch(/^Draft · Krea 2 · Z-Image · 4 renders · /);
    expect(row!.p.lower).toContain("z-image");
  });
  it("says its recipe when nothing was made from it, or from a server that does not send the models", () => {
    const { models: _, ...old } = draft;
    expect(indexItems([{ ...old, renders: 0 }], recipes, null, undefined, families)[0]!.meta).toMatch(/^Draft · txt2img · 0 renders/);
    expect(draftModels("krea2", ["zimage", "krea2"])).toEqual(["krea2", "zimage"]);
    expect(draftModels("flux", ["zimage", "krea2"])).toEqual(["zimage", "krea2"]);
  });
});

describe("places, the bin and the editor from the bar", () => {
  const asset = (id: string, project: string | null, inBin?: true) => ({
    kind: "asset" as const, id, label: `Item ${id}`, project, folder: null, updatedAt: "2026-10-10T00:00:00.000Z", assetKind: "image" as const, width: 64, height: 48, durationMs: null, bytes: 10, hasThumb: true, ...(inBin ? { inBin } : {}),
  });
  const project = (archived: boolean) => ({ kind: "project" as const, id: "p1", label: "Harbor", updatedAt: "", archived, timelines: 0, items: 0, bytes: 0 });

  it("reads `clip 3` and `undo`, and leaves `render clip 3` a render", () => {
    expect(parseCommand("clip 3")).toEqual({ cmd: "clip", number: 3 });
    expect(parseCommand("go to clip 12")).toEqual({ cmd: "clip", number: 12 });
    expect(parseCommand("clip 0")).toBeNull();
    expect(parseCommand("undo")).toEqual({ cmd: "undo" });
    expect(parseCommand("put all back")).toEqual({ cmd: "put-back-all" });
    expect(parseCommand("restore the bin")).toEqual({ cmd: "put-back-all" });
    expect(parseCommand("empty the bin")).toEqual({ cmd: "empty-bin" });
    expect(parseCommand("render clip 3")).toEqual({ cmd: "render-clips", clips: [3] });
  });
  it("lists the Inbox as a place, its items counted without the bin's", () => {
    const rows = indexItems([asset("a", null), asset("b", null, true), asset("c", "p1"), project(false)], [], "none");
    const inbox = rows.find((r) => r.inbox)!;
    expect(inbox).toMatchObject({ key: "project:inbox", kind: "project", label: "Inbox", verb: "work in it" });
    expect(inbox.meta).toBe("Out of every project · 0 timelines · 1 item · working in it");
  });
  it("counts the Inbox's items as the server says, when the index holds only some of them", () => {
    const rows = indexItems([asset("a", null), project(false)], [], null, 1234);
    expect(rows.find((r) => r.inbox)!.meta).toBe("Out of every project · 0 timelines · 1234 items");
  });
  it("adds the items found as typed, and those picked, each once and as last read", () => {
    const index = [asset("a", null), project(false)];
    const renamed = { ...asset("a", null), label: "Pier" };
    const merged = withItems(index, [asset("b", null, true)], [renamed, asset("c", "p1")]);
    expect(merged.map((e) => `${e.kind}:${e.id}`)).toEqual(["asset:a", "project:p1", "asset:b", "asset:c"]);
    expect(merged[0]).toMatchObject({ label: "Pier" });
    // nothing more: the index as it is (the same rows, nothing worked out again)
    expect(withItems(index, [], [])).toBe(index);
  });
  it("asks the index for the items used lately, newest first", () => {
    const ranks = { "render:old": { n: 5, t: 1 }, "timeline:t": { n: 1, t: 3 }, "render:new": { n: 1, t: 2 } };
    expect(usedItems(ranks)).toEqual(["new", "old"]);
    expect(usedItems(ranks, 1)).toEqual(["new"]);
  });
  it("finds what is in the bin after the rest, said so", () => {
    const [row] = indexItems([asset("b", null, true)], [], null);
    expect(row).toMatchObject({ archived: true });
    expect(row!.meta.startsWith("In the bin · Image")).toBe(true);
  });
  it("unarchives an archived project on Enter", () => {
    expect(indexItems([project(true)], [], null)[0]!.verb).toBe("unarchive");
    expect(indexItems([project(false)], [], null)[0]!.verb).toBe("work in it");
  });
  it("goes to the bin", () => {
    expect(navItems([]).find((n) => n.key === "nav:bin")!.nav).toEqual({ bin: true });
  });
});
