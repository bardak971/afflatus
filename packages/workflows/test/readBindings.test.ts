import { describe, expect, it } from "vitest";
import { bindings as schema, inspect, readBindings } from "../src";
import { catalog, flux, panel, sdxl, wan } from "./fixtures";

/** What the schema makes of a value: the same answer is asked of the reader the web uses. */
const bySchema = (v: unknown) => {
  const parsed = schema.safeParse(v);
  return parsed.success ? parsed.data : null;
};

const t = (node: string, input = "x") => ({ node, input });
const pic = { target: t("1", "image"), detach: [t("2")], required: false };

/** Bindings with every field the schema knows, filled. */
const full = {
  prompt: t("6", "text"),
  negative: t("7", "text"),
  seeds: [t("3", "seed")],
  size: { width: t("5", "width"), height: t("5", "height"), step: 8, min: 256, max: 2048 },
  length: { target: t("50", "length"), fps: 16, step: 4, offset: 1, min: 1, max: 10 },
  model: { target: t("4", "ckpt_name"), folder: "checkpoints" },
  startImage: pic,
  endImage: { ...pic, required: true },
  director: { node: "9" },
  pictures: [{ ...pic, id: "ref", label: "Reference" }],
  previousVideo: pic,
  nextVideo: pic,
  sourceVideo: pic,
  otherVideos: [{ ...pic, id: "v2", label: "Second" }],
  sound: pic,
  otherSounds: [{ ...pic, id: "s2", label: "Voice" }],
  loras: [{ node: "4", output: 0, label: "high", power: true }, { node: "5", output: 1 }],
  toggles: [
    { id: "sw_1", label: "Hires fix", default: true, captions: { on: "A", off: "B" }, effects: [{ nodes: ["1", "2"], activeWhen: true, mode: "bypass" }], writes: [t("8")], front: true, help: "?", made: true },
    { id: "sw_2", label: "Plain", default: false, effects: [{ nodes: ["3"], activeWhen: false, mode: "skip" }] },
  ],
  sections: [{ id: "s", label: "Upscale", items: ["ctl_1", { toggle: "sw_1", items: ["ctl_2"] }, { toggle: "sw_2" }], help: "notes" }, { id: "e", label: "Empty" }],
  skip: [{ node: "20", nodes: ["21", "22"] }],
  result: { node: "9", kind: "video", sound: true },
  controls: [
    { id: "ctl_3_steps", label: "Steps", target: t("3", "steps"), kind: "number", default: 20, min: 1, max: 100, step: 1, also: [t("4", "steps")], front: true, help: "h" },
    { id: "ctl_3_s", label: "Sampler", target: t("3", "sampler_name"), kind: "choice", default: "euler", choices: { node: "KSampler", input: "sampler_name" }, file: false },
    { id: "ctl_3_b", label: "On", target: t("3", "b"), kind: "toggle", default: true, captions: { on: "y", off: "n" } },
    { id: "ctl_3_p", label: "Pick", target: t("3", "p"), kind: "number", default: 1, picks: [{ value: 1, label: "one" }] },
  ],
  stages: [{ node: "9", label: "First" }],
  extra: "dropped",
};

/** Every path into a value, for spoiling one place at a time. */
function paths(v: unknown, at: (string | number)[] = []): (string | number)[][] {
  if (!v || typeof v !== "object") return [at];
  const keys: (string | number)[] = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
  return [at, ...keys.flatMap((k) => paths((v as Record<string | number, unknown>)[k], [...at, k]))];
}

function spoiled(path: (string | number)[], to: unknown): unknown {
  const copy = structuredClone(full) as unknown;
  if (!path.length) return to;
  let at = copy as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) at = at[k] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  if (to === "<gone>") delete at[last];
  else at[last] = to;
  return copy;
}

describe("readBindings: the schema's answers without zod", () => {
  it("reads the bindings the importer suggests as the schema does", () => {
    for (const graph of [sdxl, wan, panel, flux]) {
      const suggested = inspect(graph, catalog).suggested;
      expect(readBindings(suggested)).toEqual(bySchema(suggested));
      expect(readBindings(suggested)).not.toBeNull();
    }
  });

  it("reads full bindings as the schema does, defaults filled and unknown fields dropped", () => {
    const read = readBindings(full);
    expect(read).toEqual(bySchema(full));
    expect(read).not.toHaveProperty("extra");
    expect(read!.loras[1]!.label).toBe("");
    expect(read!.toggles[1]!.writes).toEqual([]);
    expect(read!.sections[1]!.items).toEqual([]);
  });

  it("fills the defaults of the least bindings as the schema does", () => {
    const least = { result: { node: "9", kind: "image" } };
    expect(readBindings(least)).toEqual(bySchema(least));
  });

  it("accepts and refuses as the schema does, whatever one place of the bindings is spoiled with", () => {
    const spoils: unknown[] = ["<gone>", null, 1, Number.NaN, "x", true, [], {}, [1], [{}]];
    let refused = 0;
    for (const path of paths(full)) {
      for (const to of spoils) {
        const v = spoiled(path, to);
        const want = bySchema(v);
        expect(readBindings(v), `${path.join(".")} = ${JSON.stringify(to)}`).toEqual(want);
        if (!want) refused++;
      }
    }
    // the spoils reach every kind of field: most of them are refused
    expect(refused).toBeGreaterThan(500);
  });
});
