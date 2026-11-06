/**
 * The golden graph dump (card #287): what every recipe builds, written once and compared after a refactor, so that a change
 * meant to keep the graphs (rows shared, a pass written once) proves it did. No GPU, no ComfyUI.
 *   pnpm golden:write     writes golden/<recipe>.json (git-ignored) from this checkout
 *   pnpm golden:diff      builds again and names each recipe and case that changed, and how; exit 1 if any did
 *   pnpm golden:diff sdxl only the recipes whose id starts so
 *
 * A case is a check-graphs variant (built as check:graphs builds it, the saved node catalog's inputs included), or a row of a
 * form moved off its value on the first variant that shows it, as inputsReachGraph.test.ts moves it: every toggle flipped,
 * every number at its max, min and middle, every choice's other options. Each holds the built graph with its node ids
 * renumbered in order, the rest of what build() says (phases, outputs, passes, totalSteps, loads…), needsWith on an own machine
 * and on a pod, nodes and finishing; and once per recipe its rows in order as JSON has them (labels, notes, ranges), its
 * optionalNodes and its traits.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dryContext, inputsIn, parseInput, plural, type BuiltGraph, type NodeCatalog, type Recipe } from "@afflatus/core";
import { recipes } from "@afflatus/recipes";
import { EXTRA_FILES, other, shown } from "../packages/recipes/test/rowValues";

type Values = Record<string, unknown>;
type Variant = Recipe<any>["variants"][number];
type Dump = Record<string, unknown>;

const dir = fileURLToPath(new URL("../golden/", import.meta.url));
const mode = process.argv[2];
const only = process.argv[3] ?? "";
if (mode !== "write" && mode !== "diff") {
  console.log("usage: tsx scripts/golden-graphs.ts write|diff [recipe id prefix]");
  process.exit(2);
}

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL("../reference/comfy-object-info.json", import.meta.url)), "utf-8")) as NodeCatalog;
// the inputs each node takes, as check-graphs.ts hands them: a recipe that names an input only where the node has it builds the same
const inputsOf = inputsIn(catalog);

/**
 * The graph with its node ids renumbered 1, 2… in the order they were made, and every link, phase, output and pass moved with
 * them: a refactor that names its nodes otherwise is not a change.
 */
function renumbered(built: BuiltGraph): Dump {
  const ids = new Map(Object.keys(built.graph).map((id, n) => [id, String(n + 1)]));
  const to = (id: string) => ids.get(id) ?? id;
  const links = (v: unknown): unknown =>
    Array.isArray(v) ? (v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number" && ids.has(v[0]) ? [to(v[0]), v[1]] : v.map(links)) : v;
  const graph = Object.fromEntries(Object.entries(built.graph).map(([id, n]) => [to(id), { ...n, inputs: Object.fromEntries(Object.entries(n.inputs).map(([k, v]) => [k, links(v)])) }]));
  return {
    ...built,
    graph,
    phases: Object.fromEntries(Object.entries(built.phases).map(([id, p]) => [to(id), p])),
    outputs: built.outputs.map((o) => ({ ...o, node: to(o.node) })),
    ...(built.passes ? { passes: built.passes.map((p) => ({ ...p, node: to(p.node) })) } : {}),
  };
}

/** One case: what the recipe builds and says for this input, or the error it throws. */
function caseOf(r: Recipe<any>, raw: Values, v: Variant, ctx: () => ReturnType<typeof dryContext>): Dump {
  try {
    const input = parseInput(r, raw);
    const slots = v.slots ?? {};
    return {
      built: renumbered(r.build(input, ctx())),
      needsOwn: r.needsWith?.(input, slots, { own: true }) ?? null,
      needsPod: r.needsWith?.(input, slots, { own: false }) ?? null,
      nodes: r.nodes(input),
      finishing: r.finishing?.(input) ?? null,
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Every case of a recipe, by name. */
function dumpOf(r: Recipe<any>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "(recipe)": { inputs: r.inputs, optionalNodes: r.optionalNodes ?? null, traits: r.traits ?? null },
  };
  for (const v of r.variants) {
    const ctx = () => dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas, inputs: inputsOf, ...(v.has ? { has: v.has } : {}) });
    out[`variant ${v.name}`] = caseOf(r, v.input as Values, v, ctx);
  }
  for (const spec of r.inputs) {
    if (!["number", "toggle", "choice"].includes(spec.type)) continue;
    for (const v of r.variants) {
      const at = shown(r, spec, v);
      if (!at) continue;
      const ctx = () => dryContext({ slots: { ...EXTRA_FILES, ...v.slots }, uploads: at.uploads, media: at.media as never, canvas: v.canvas, inputs: inputsOf, ...(v.has ? { has: v.has } : {}) });
      let now: unknown;
      try {
        now = (parseInput(r, at.input) as Values)[spec.id];
      } catch {
        continue;
      }
      for (const value of other(spec, now)) out[`row ${spec.id}=${JSON.stringify(value)} (on ${v.name})`] = caseOf(r, { ...at.input, [spec.id]: value }, v, ctx);
      break;
    }
  }
  return out;
}

const fileOf = (id: string) => `${dir}${id}.json`;
const short = (v: unknown) => {
  const s = JSON.stringify(v) ?? "undefined";
  return s.length > 140 ? `${s.slice(0, 137)}...` : s;
};

/** The paths where two dumps part, each with its old and new value: a node added, an input changed, a need dropped. */
function differences(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length >= 40) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in b)) out.push(`${path}.${k}: removed (was ${short(a[k])})`);
      else if (!(k in a)) out.push(`${path}.${k}: added ${short(b[k])}`);
      else differences(a[k], b[k], `${path}.${k}`, out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => differences(x, b[i], `${path}[${i}]`, out));
    return;
  }
  out.push(`${path}: ${short(a)} → ${short(b)}`);
}

const chosen = recipes.filter((r) => r.id.startsWith(only));
if (mode === "write") {
  mkdirSync(dir, { recursive: true });
  // a recipe gone since the last write leaves no file to be compared with
  for (const f of readdirSync(dir)) if (f.endsWith(".json") && f.startsWith(only) && !chosen.some((r) => `${r.id}.json` === f)) writeFileSync(`${dir}${f}`, "");
  let cases = 0;
  for (const r of chosen) {
    const dump = dumpOf(r);
    cases += Object.keys(dump).length - 1;
    writeFileSync(fileOf(r.id), `${JSON.stringify(dump, null, 1)}\n`);
  }
  console.log(`golden/: ${plural(chosen.length, "recipe")}, ${plural(cases, "case")} written`);
  process.exit(0);
}

let changed = 0;
let cases = 0;
for (const r of chosen) {
  let was: Record<string, unknown>;
  try {
    was = JSON.parse(readFileSync(fileOf(r.id), "utf-8")) as Record<string, unknown>;
  } catch {
    changed++;
    console.log(`NEW  ${r.id}: no golden file (run golden:write on the commit to compare with)`);
    continue;
  }
  const now = dumpOf(r);
  for (const name of new Set([...Object.keys(was), ...Object.keys(now)])) {
    cases++;
    if (!(name in now)) {
      changed++;
      console.log(`GONE ${r.id} · ${name}`);
    } else if (!(name in was)) {
      changed++;
      console.log(`NEW  ${r.id} · ${name}`);
    } else {
      const lines: string[] = [];
      differences(was[name], now[name], "", lines);
      if (!lines.length) continue;
      changed++;
      console.log(`DIFF ${r.id} · ${name}${lines.map((l) => `\n     ${l.replace(/^\./, "")}`).join("")}`);
    }
  }
}
for (const f of existsSync(dir) ? readdirSync(dir) : []) {
  const id = f.replace(/\.json$/, "");
  if (f.endsWith(".json") && id.startsWith(only) && !chosen.some((r) => r.id === id) && readFileSync(`${dir}${f}`, "utf-8").trim()) {
    changed++;
    console.log(`GONE ${id}: the recipe is no longer there`);
  }
}
console.log(`\n${plural(cases, "case")} compared, ${changed ? `${changed} changed` : "none changed"}`);
process.exit(changed ? 1 : 0);
