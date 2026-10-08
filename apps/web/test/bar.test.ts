import { describe, expect, it } from "vitest";
import { castPlace, clipRefuses, withPerson, type ClipCast } from "../src/bar/castTo";
import { atTop } from "../src/screens/queue/order";
import { arithmetic, calc, gridFramesAtLeast, ratioOf, sizeFor, type Grid } from "../src/bar/calc";
import { indexItems, timelineLength } from "../src/bar/items";
import { highlight, pieces, prepare, QUALITY, score, search } from "../src/bar/match";
import { clipList, modeOf, parseCommand, sizeOf } from "../src/bar/parse";
import { bonus, bumped, frecency, HALF_LIFE_MS, KEPT, recentKeys } from "../src/bar/rank";
import { expandSnippet, slugOf, snippetsFor, typedTrigger } from "../src/bar/snippets";

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
    expect(parseCommand("empty the bin")).toEqual({ cmd: "empty-bin" });
    expect(parseCommand("bin unused takes")).toEqual({ cmd: "bin-unused" });
    expect(parseCommand("link folder D:\\shoots")).toEqual({ cmd: "link-folder", path: "D:\\shoots" });
    expect(parseCommand("link folder")).toEqual({ cmd: "link-folder", path: "" });
    expect(parseCommand("new project Harbor")).toEqual({ cmd: "new-project", name: "Harbor" });
    expect(parseCommand("render")).toBeNull();
    expect(parseCommand("make it pop")).toBeNull();
  });
  it("reads a size", () => {
    expect(sizeOf("1152x2048")).toEqual({ width: 1152, height: 2048 });
    expect(sizeOf("big")).toBeNull();
  });
});

describe("calculator", () => {
  it("gives the frames of a length on the model's grid", () => {
    expect(gridFramesAtLeast(168, H3.frames)).toBe(175);
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
});

describe("snippets", () => {
  const list = [{ name: "Cine look", text: "Live-action, cinematic" }, { name: "Night", text: "Night exterior, wet streets" }, { name: "Night rain", text: "Rain at night" }];
  it("makes a name a slug", () => {
    expect(slugOf("Cine look")).toBe("cine-look");
    expect(slugOf("  Été / pluie!! ")).toBe("ete-pluie");
  });
  it("expands ;name before the cursor", () => {
    expect(expandSnippet("A harbor ;cine-look", 19, list)).toEqual({ text: "A harbor Live-action, cinematic", caret: 31 });
    expect(expandSnippet(";night", 6, list)).toEqual({ text: "Night exterior, wet streets", caret: 27 });
    expect(expandSnippet("x ;cine-look and more", 12, list)).toEqual({ text: "x Live-action, cinematic and more", caret: 24 });
  });
  it("leaves alone what is no snippet", () => {
    expect(expandSnippet("a;cine-look", 11, list)).toBeNull();
    expect(expandSnippet(";nope", 5, list)).toBeNull();
    expect(expandSnippet(";", 1, list)).toBeNull();
    expect(expandSnippet("plain", 5, list)).toBeNull();
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
