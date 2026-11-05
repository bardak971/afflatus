import { describe, expect, it } from "vitest";
import { peopleFor, typedPerson, withoutTyped } from "../src/regions/castTyping";
import { handleOn } from "../src/stageLayer/geometry";
import { droppedBox, drawnBox, isBox, keptInside, movedBox, newRegionId, pixelBox, regionAt, resizedBox, unitPoint, whereSaid } from "../src/regions/geometry";
import { regionsSummary } from "../src/regions/RegionsField";
import { regionsAbsent, regionsHow, regionList, regionsSpecOf, type RegionValue } from "../src/regions/types";
import { chipSaid } from "../src/regions/useRegionTool";
import { carryAcross } from "../src/picker";
import type { RecipeInfo } from "../src/api";
import { formSize, heldElsewhere } from "../src/regions/useRegionsStage";

/** Regions on the Stage (card #271): boxes kept in parts of the frame, drawn, moved, resized, picked, said. */

const near = (b: { x: number; y: number; w: number; h: number }) => ({ x: +b.x.toFixed(4), y: +b.y.toFixed(4), w: +b.w.toFixed(4), h: +b.h.toFixed(4) });
const region = (id: string, box: RegionValue["box"], more: Partial<RegionValue> = {}): RegionValue => ({ id, box, prompt: "", ...more });

describe("a region's box", () => {
  it("is drawn either way round, and cut at the frame's edges", () => {
    expect(near(drawnBox({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.1 }))).toEqual({ x: 0.2, y: 0.1, w: 0.4, h: 0.6 });
    expect(near(drawnBox({ x: -0.2, y: 0.5 }, { x: 0.3, y: 1.4 }))).toEqual({ x: 0, y: 0.5, w: 0.3, h: 0.5 });
  });

  it("is no box when a click draws it", () => {
    expect(isBox(drawnBox({ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.52 }))).toBe(false);
    expect(isBox(drawnBox({ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.6 }))).toBe(true);
  });

  it("moves whole, and stops at an edge without shrinking", () => {
    const b = { x: 0.1, y: 0.1, w: 0.3, h: 0.4 };
    expect(near(movedBox(b, 0.2, 0.1))).toEqual({ x: 0.3, y: 0.2, w: 0.3, h: 0.4 });
    expect(near(movedBox(b, 0.9, -0.5))).toEqual({ x: 0.7, y: 0, w: 0.3, h: 0.4 });
    expect(keptInside({ x: -0.1, y: 0.9, w: 0.2, h: 0.2 })).toEqual({ x: 0, y: 0.8, w: 0.2, h: 0.2 });
  });

  it("resizes by the sides its handle holds, never past an edge nor inside out", () => {
    const b = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    expect(near(resizedBox(b, "se", 0.1, 0.2))).toEqual({ x: 0.2, y: 0.2, w: 0.5, h: 0.6 });
    expect(near(resizedBox(b, "w", -0.5, 0.3))).toEqual({ x: 0, y: 0.2, w: 0.6, h: 0.4 });
    // dragged past the other side: held at the smallest side
    const flipped = resizedBox(b, "n", 0, 0.9);
    expect(flipped.h).toBeCloseTo(0.03);
    expect(flipped.y + flipped.h).toBeCloseTo(0.6);
  });

  it("is taken by its handles near its edge, a corner before a side, nothing in its middle", () => {
    const px = { x: 100, y: 100, w: 200, h: 100 };
    expect(handleOn({ x: 102, y: 98 }, px, 6)).toBe("nw");
    expect(handleOn({ x: 300, y: 150 }, px, 6)).toBe("e");
    expect(handleOn({ x: 200, y: 203 }, px, 6)).toBe("s");
    expect(handleOn({ x: 200, y: 150 }, px, 6)).toBeNull();
    expect(handleOn({ x: 500, y: 150 }, px, 6)).toBeNull();
  });

  it("keeps its place on the picture when the form's size changes", () => {
    const at1216 = { w: 1216, h: 832 };
    const box = drawnBox(unitPoint({ x: 109, y: 75 }, at1216), unitPoint({ x: 547, y: 790 }, at1216));
    // the same box over a 832 × 1216 picture: the same part of it
    const other = pixelBox(box, { w: 832, h: 1216 });
    expect(other.x / 832).toBeCloseTo(109 / 1216);
    expect((other.y + other.h) / 1216).toBeCloseTo(790 / 832);
  });

  it("picks the one on top where boxes overlap", () => {
    const list = [region("a", { x: 0, y: 0, w: 0.6, h: 0.6 }), region("b", { x: 0.4, y: 0.4, w: 0.5, h: 0.5 })];
    expect(regionAt(list, { x: 0.5, y: 0.5 })?.id).toBe("b");
    expect(regionAt(list, { x: 0.1, y: 0.1 })?.id).toBe("a");
    expect(regionAt(list, { x: 0.95, y: 0.05 })).toBeUndefined();
  });

  it("is made where a person is dropped, held inside the frame", () => {
    const b = droppedBox({ x: 0.95, y: 0.5 });
    expect(b.x + b.w).toBeCloseTo(1);
    expect(b.y + b.h / 2).toBeCloseTo(0.5);
  });

  it("gets an id no other region has", () => {
    expect(newRegionId([region("r1", { x: 0, y: 0, w: 1, h: 1 }), region("r3", { x: 0, y: 0, w: 1, h: 1 })])).toBe("r4");
    expect(newRegionId([])).toBe("r1");
  });

  it("says where it is in a few words", () => {
    expect(whereSaid({ x: 0.09, y: 0.05, w: 0.36, h: 0.9 })).toBe("left · x 9–45 %");
    expect(whereSaid({ x: 0.1, y: 0.06, w: 0.8, h: 0.24 })).toBe("top · y 6–30 %");
    expect(whereSaid({ x: 0.05, y: 0.7, w: 0.25, h: 0.25 })).toBe("bottom left");
    expect(whereSaid({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toBe("middle");
  });
});

describe("a cast person typed with @", () => {
  const people = [{ name: "Nicolas" }, { name: "Mira" }, { name: "Ada Nico" }];

  it("is read after a space or at the start, not inside an address", () => {
    expect(typedPerson("laughing @Ni", 12)).toEqual({ word: "ni", start: 9 });
    expect(typedPerson("@", 1)).toEqual({ word: "", start: 0 });
    expect(typedPerson("mail me@home", 12)).toBeNull();
    // a name with a space in it, read whole while it is typed
    expect(typedPerson("@zz-test m", 10)).toEqual({ word: "zz-test m", start: 0 });
    expect(peopleFor("zz-test m", [{ name: "zz-test Mira" }, { name: "zz-test Nicolas" }]).map((p) => p.name)).toEqual(["zz-test Mira"]);
    // words typed on past a name: no one's name starts so, the list closes
    expect(peopleFor("mira laughing", [{ name: "Mira" }])).toEqual([]);
  });

  it("lists the people whose name starts with it, the exact one first", () => {
    expect(peopleFor("nico", people).map((p) => p.name)).toEqual(["Nicolas", "Ada Nico"]);
    expect(peopleFor("", people)).toHaveLength(3);
    expect(peopleFor("mira", people)[0]!.name).toBe("Mira");
  });

  it("leaves the words around it, the @name taken out", () => {
    expect(withoutTyped("laughing @Ni in a suit", 9, 12)).toEqual({ text: "laughing in a suit", caret: 9 });
    expect(withoutTyped("@Mira woman", 0, 5)).toEqual({ text: "woman", caret: 0 });
  });
});

describe("what the regions say", () => {
  const names = (id: string) => ({ n: "Nicolas" })[id];
  const list = [region("r1", { x: 0.09, y: 0.05, w: 0.36, h: 0.9 }, { cast: "n", prompt: "laughing" }), region("r2", { x: 0.55, y: 0.05, w: 0.34, h: 0.9 }, { prompt: "woman in a red coat" })];

  it("folded: how many, and each by its person or its first words", () => {
    expect(regionsSummary(list, names)).toBe("2 on the Stage · @Nicolas left · woman in a right");
    expect(regionsSummary([], names)).toMatch(/^none/);
  });

  it("on its chip: its number, its person, its words", () => {
    expect(chipSaid(list[0]!, 1, names)).toBe("1 · @Nicolas · laughing");
    expect(chipSaid(region("t", { x: 0, y: 0, w: 1, h: 1 }, { kind: "text" }), 3, names)).toBe("3 · Text");
  });

  it("reads only well-formed regions from a form's value", () => {
    expect(regionList([list[0], { id: 3 }, null, "x"])).toHaveLength(1);
    expect(regionList("nothing")).toEqual([]);
  });

  it("finds the Regions input, or why a model takes none", () => {
    expect(regionsSpecOf([{ id: "prompt", type: "prompt", label: "Prompt", style: "tags" }, { id: "regions", type: "regions", label: "Regions", max: 8 }])?.id).toBe("regions");
    expect(regionsAbsent([{ id: "references", label: "Reference images", why: "x" }, { id: "regions", label: "Regions", why: "Qwen 2.1 has no regional prompting" }])?.why).toBe("Qwen 2.1 has no regional prompting");
    expect(regionsHow({ id: "regions", type: "regions", label: "Regions", max: 8, kinds: true })).toMatch(/object or a text/);
  });

  it("finds the boxes a draft keeps on another model's form, for a model that takes none", () => {
    expect(heldElsewhere({ "qwen.t2i": { prompt: "x" }, "sdxl.t2i": { regions: list } })).toHaveLength(2);
    expect(heldElsewhere(undefined)).toEqual([]);
  });

  it("draws the empty frame at the form's size, or a square", () => {
    expect(formSize([{ id: "size", type: "size" }], { size: { width: 1216, height: 832 } })).toEqual({ w: 1216, h: 832 });
    expect(formSize([], {})).toEqual({ w: 1024, h: 1024 });
  });
});

describe("the boxes on a model switch", () => {
  const recipe = (id: string, regions: object | null) => ({ id, family: id, output: "image", title: id, inputs: [{ id: "prompt", type: "prompt", label: "Prompt", style: "sentences" }, ...(regions ? [{ id: "regions", type: "regions", label: "Regions", max: 8, ...regions }] : [])] }) as unknown as RecipeInfo;
  const sdxl = recipe("sdxl", { lora: "scoped" });
  const moss = recipe("moss", { lora: "global", kinds: true });
  const qwen = recipe("qwen21", null);
  const lamp = { id: "r1", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, prompt: "a lamp", lora: { file: "zz-test.safetensors", weight: 0.8 } };
  const sign = { id: "r2", box: { x: 0.5, y: 0.5, w: 0.4, h: 0.2 }, prompt: "bold serif", kind: "text" as const, text: "OPEN" };

  it("go along to a model that takes them, as it takes them", () => {
    expect(carryAcross(sdxl, moss, { regions: [lamp] }, undefined).regions).toEqual([lamp]);
    // a text box has no place on SDXL
    expect(carryAcross(moss, sdxl, { regions: [lamp, sign] }, undefined).regions).toEqual([lamp]);
  });

  it("stay behind on a model that takes none, and never replace boxes the other form holds", () => {
    expect(carryAcross(sdxl, qwen, { regions: [lamp] }, undefined).regions).toBeUndefined();
    expect(carryAcross(sdxl, moss, { regions: [lamp] }, { regions: [sign] }).regions).toBeUndefined();
  });
});
