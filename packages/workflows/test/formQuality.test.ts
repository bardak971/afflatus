import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRef, type Graph } from "@afflatus/core";
import { fromEditor, inputNode, inspect, isEditorFormat, placeablesFor, recipeFromWorkflow, soleValue, suggestSections, type Bindings, type Wiring, type WorkflowDef } from "../src";
import { catalog as fixtures } from "./fixtures";

/**
 * How close the suggested form comes to what each corpus workflow's author set up themselves, where the
 * suggester's own score (suggestCorpus: how much it places) cannot tell:
 * - the author's front: the settings on the front of their group nodes, the single settings they named, and the
 *   value nodes they renamed ("Steps", "Seed"). How many of them are on the form, and how many up front (not in
 *   Advanced, not left out of every section);
 * - what Afflatus ticks of its own, not the author's;
 * - the author's frames: two settings of one frame put in different sections (split), two of different frames put
 *   in one section (mixed); and how many sections carry a frame's title.
 * Printed, with the workflows that score worst, for the next rule to write. Skipped without the corpus.
 */
const dir = join(import.meta.dirname, "corpus");
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "expect.json").sort() : [];
// read with every pack's nodes where the throwaway ComfyUI's catalog was kept (comfyExport.mjs), else the reference one
const full = join(dir, "comfy-api-full", "_object_info.json");
const catalog = existsSync(full) ? (JSON.parse(readFileSync(full, "utf8")) as typeof fixtures) : fixtures;

type At = { node: string; input: string };
const key = (t: At) => `${t.node}.${t.input}`;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The settings the author put forward: their panel, the settings they named, the value nodes they renamed. Settings only: a renamed link is not one. */
function authorsFront(graph: Graph, wiring: Wiring): Map<string, At> {
  const front = new Map<string, At>();
  const setting = (t: At) => graph[t.node] && Object.hasOwn(graph[t.node]!.inputs, t.input) && !isRef(graph[t.node]!.inputs[t.input]);
  for (const t of wiring.panel) if (setting(t)) front.set(key(t), t);
  for (const name of Object.keys(wiring.labels)) {
    const dot = name.lastIndexOf(".");
    const t = { node: name.slice(0, dot), input: name.slice(dot + 1) };
    if (setting(t)) front.set(key(t), t);
  }
  for (const [id, n] of Object.entries(graph)) {
    const held = soleValue(n);
    const title = (n as { _meta?: { title?: string } })._meta?.title;
    const plain = catalog[n.class_type]?.display_name ?? n.class_type;
    if (held && title && norm(title) !== norm(plain) && norm(title) !== norm(n.class_type) && ["number", "boolean"].includes(typeof held.value)) front.set(key({ node: id, input: held.input }), { node: id, input: held.input });
  }
  return front;
}

/** Each form input's id, by the setting it writes. */
function formTargets(b: Bindings): Map<string, string> {
  const at = new Map<string, string>();
  const put = (t: At | undefined, id: string) => t && !at.has(key(t)) && at.set(key(t), id);
  put(b.prompt, "prompt");
  put(b.negative, "negative");
  put(b.model?.target, "model");
  for (const s of b.seeds) put(s, "seed");
  put(b.size?.width, "size");
  put(b.size?.height, "size");
  put(b.length?.target, "seconds");
  for (const c of b.controls) for (const t of [c.target, ...(c.also ?? [])]) put(t, c.id);
  for (const t of b.toggles) for (const w of t.writes) put(w, t.id);
  return at;
}

/** The frame a node is drawn in (the innermost one: each frame lists only the nodes it holds itself). */
const frameOf = (frames: Wiring["frames"], node: string | undefined) => (node ? frames.findIndex((f) => f.nodes.includes(node)) : -1);

describe.skipIf(!files.length)("the suggested forms against what their authors set up", () => {
  it("keep the author's front up front, and their frames together", () => {
    const t = { front: 0, onForm: 0, upFront: 0, ticked: 0, ours: 0, pairsInFrame: 0, split: 0, pairsInSection: 0, mixed: 0, sections: 0, titled: 0, framed: 0 };
    const lost = new Map<string, number>();
    const clutter = new Map<string, number>();
    const worst: Array<{ file: string; score: number; why: string }> = [];
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (!isEditorFormat(raw)) continue;
      const read = fromEditor(raw, catalog);
      const found = inspect(read.graph, catalog, read.wiring, read.notes);
      const b = found.suggested;
      if (!b || !read.wiring) continue;
      const def = { id: "w", title: "t", model: "", source: file, graph: read.graph, wiring: read.wiring, bindings: b } as WorkflowDef;
      let inputs;
      try { inputs = recipeFromWorkflow(def).inputs; } catch { continue; }
      const placeables = placeablesFor(b, inputs);
      const frames = read.wiring.frames;
      const made = suggestSections(read.graph, read.wiring, b.result.node, placeables, frames, b.toggles);
      const sectionOf = new Map<string, number>();
      made.sections.forEach((s, i) => s.items.forEach((item) => (typeof item === "string" ? [item] : [item.toggle, ...item.items]).forEach((id) => sectionOf.set(id, i))));
      // the chapter a section belongs to: a large frame's parts ("Stage 2 Video · Image Filter") are one chapter with it
      const chapters = [...new Set(made.sections.map((s) => s.label.split(" · ")[0]!))];
      const chapterOf = (id: string) => (sectionOf.has(id) ? chapters.indexOf(made.sections[sectionOf.get(id)!]!.label.split(" · ")[0]!) : undefined);
      const buried = (id: string) => {
        if (id === "prompt" || id === "negative") return false;
        const s = sectionOf.get(id);
        return s === undefined || /^advanced$/i.test(made.sections[s]!.label) || made.sections[s]!.id === "advanced";
      };
      const onFormIds = new Set(inputs.map((i) => i.id));

      // the author's front
      // a node its author muted, with no switch to turn it on, does not run: its settings are not for the form
      const runs = (node: string) => !read.wiring!.modes[node] || b.toggles.some((tg) => tg.effects.some((e) => e.nodes.includes(node)));
      const front = new Map([...authorsFront(read.graph, read.wiring)].filter(([, at]) => runs(at.node)));
      const targets = formTargets(b);
      let fileFront = 0;
      let fileUp = 0;
      const upIds = new Set<string>();
      for (const [k, at] of front) {
        const id = targets.get(k);
        t.front++;
        fileFront++;
        if (!id || !onFormIds.has(id)) {
          const kind = `${read.graph[at.node]?.class_type ?? "?"}.${at.input}`;
          lost.set(kind, (lost.get(kind) ?? 0) + 1);
          continue;
        }
        t.onForm++;
        if (!buried(id)) { t.upFront++; fileUp++; upIds.add(id); }
      }
      // what Afflatus ticks of its own: not the author's, ticked all the same (the steps and cfg when the author put nothing forward, the size, the length)
      for (const c of found.candidates.filter((c) => c.suggested)) {
        t.ticked++;
        if (c.byAuthor) continue;
        t.ours++;
        const kind = `${c.classType}.${c.target.input}`;
        clutter.set(kind, (clutter.get(kind) ?? 0) + 1);
      }
      // the author's frames against the sections
      const framedItems = placeables.map((p) => ({ id: p.id, frame: frameOf(frames, p.node ?? inputNode(b, p.id)), section: chapterOf(p.id) })).filter((x) => x.frame >= 0 && x.section !== undefined);
      for (let i = 0; i < framedItems.length; i++) {
        for (let j = i + 1; j < framedItems.length; j++) {
          const [x, y] = [framedItems[i]!, framedItems[j]!];
          // (a frame is known by its place in the list; two frames of the same title are one frame to whoever reads the form)
          if (x.frame === y.frame) { t.pairsInFrame++; if (x.section !== y.section) t.split++; }
          if (x.section === y.section) { t.pairsInSection++; if (x.frame !== y.frame) t.mixed++; }
        }
      }
      if (frames.length) {
        t.framed++;
        // a section named after a frame: its title, or the start of it once tidied ("Alternativ - Test 3 Sampler" → "Alternativ")
        const titles = frames.map((f) => norm(f.title));
        for (const s of made.sections.filter((s) => s.items.length)) {
          t.sections++;
          const name = norm(s.label.split(" · ")[0]!);
          if (name && titles.some((ft) => ft === name || ft.startsWith(`${name} `) || ft.includes(` ${name}`) || ft.includes(name))) t.titled++;
        }
      }
      if (fileFront >= 3) worst.push({ file, score: fileUp / fileFront, why: `${fileUp}/${fileFront} of the author's front up front` });
    }
    const pc = (a: number, b: number) => `${b ? Math.round((a / b) * 1000) / 10 : 0} %`;
    const report = [
      `author's front: ${t.front} settings; on the form ${pc(t.onForm, t.front)}, up front ${pc(t.upFront, t.front)}`,
      `ticked widgets: ${t.ticked}, of which Afflatus's own (not the author's) ${t.ours} (${pc(t.ours, t.ticked)})`,
      `frames: a frame's settings split over sections ${pc(t.split, t.pairsInFrame)} of pairs; a section mixing frames ${pc(t.mixed, t.pairsInSection)} of pairs`,
      `section names: ${pc(t.titled, t.sections)} of ${t.sections} sections (in ${t.framed} framed workflows) carry a frame's title`,
      `the author's front not on the form, by node:\n  ${[...lost].sort((a, z) => z[1] - a[1]).slice(0, 15).map(([k, n]) => `${n} ${k}`).join("\n  ")}`,
      `ticked by Afflatus, not the author, by node:\n  ${[...clutter].sort((a, z) => z[1] - a[1]).slice(0, 15).map(([k, n]) => `${n} ${k}`).join("\n  ")}`,
      `lowest share of the author's front up front:\n  ${worst.sort((a, z) => a.score - z.score).slice(0, 12).map((w) => `${w.why}  ${w.file}`).join("\n  ")}`,
    ].join("\n");
    writeFileSync(join(dir, "_form-quality.txt"), report);
    console.log(report);
    expect(t.front).toBeGreaterThan(0);
  }, 180_000);
});
