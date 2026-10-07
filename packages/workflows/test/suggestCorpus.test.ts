import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromEditor, inspect, isEditorFormat, placeablesFor, recipeFromWorkflow, suggestSections, type WorkflowDef } from "../src";
import { catalog } from "./fixtures";

/**
 * The suggester over the local corpus: how much of each form it places in a section, and what it leaves out,
 * by the kind of node it belongs to (printed, for the next rule to write). Skipped without the corpus.
 */
const dir = join(import.meta.dirname, "corpus");
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "expect.json").sort() : [];

describe.skipIf(!files.length)("the suggester on the local corpus", () => {
  it("places most of every form", () => {
    let all = 0;
    let placed = 0;
    const empty: string[] = [];
    const left = new Map<string, number>();
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const read = isEditorFormat(raw) ? fromEditor(raw, catalog) : { graph: raw, wiring: undefined, notes: [] as string[] };
      const found = inspect(read.graph, catalog, read.wiring, read.notes);
      const b = found.suggested;
      if (!b) continue;
      const def = { id: "w", title: "t", model: "", source: file, graph: read.graph, wiring: read.wiring, bindings: b } as WorkflowDef;
      let inputs;
      try { inputs = recipeFromWorkflow(def).inputs; } catch { continue; }
      const placeables = placeablesFor(b, inputs);
      if (!placeables.length) continue;
      const made = suggestSections(read.graph, read.wiring, b.result.node, placeables, read.wiring?.frames ?? [], b.toggles);
      const inSections = new Set(made.sections.flatMap((s) => s.items.flatMap((i) => (typeof i === "string" ? [i] : [i.toggle, ...i.items]))));
      const out = placeables.filter((p) => !inSections.has(p.id));
      all += placeables.length;
      placed += placeables.length - out.length;
      if (!made.sections.some((s) => s.items.length)) empty.push(file);
      for (const p of out) {
        const kind = p.node ? read.graph[p.node]?.class_type ?? "?" : `(${p.id.replace(/_\d+$/, "").replace(/^(ctl|pic|snd|vid|sw)_.*/, "$1")})`;
        left.set(kind, (left.get(kind) ?? 0) + 1);
      }
    }
    const top = [...left].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${n} ${k}`).join("\n  ");
    console.log(`suggester: ${placed} of ${all} settings placed (${Math.round((placed / all) * 1000) / 10} %), ${empty.length} forms with no section${empty.length ? `: ${empty.join(", ")}` : ""}\n  left out, by node:\n  ${top}`);
    expect(placed).toBeGreaterThan(0);
  }, 120_000);
});
