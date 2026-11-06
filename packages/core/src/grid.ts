import { carryAcross, carryOver } from "./carryOver";
import { formModelInput, PROMPT_MOST, type InputSpec, type LoraValue } from "./inputs";
import { RANDOM_SEED } from "./seed";
import { withinPixels } from "./frame";
import { capRoom, usd, type CapsSpent } from "./money";
import { modelStem } from "./modelFiles";
import type { PictureOp } from "./recipe";
import { SEED_RANGE } from "./seed";
import { plural, squash } from "./text";

/**
 * X/Y/Z grids (card #21), as A1111's X/Y/Z plot makes them: up to three axes, each a setting of the form and the values it
 * takes, every combination rendered as a job of its own and laid out as one board. An axis is typed as A1111 types it
 * (`20, 30, 40`, `1-5`, `1-10 (+2)`, `0.5-1 [3]`), picked for a list, or a prompt search and replace. What is parsed here is
 * shared by the form (the count and the cost said before queuing) and the server (the cells it queues).
 */

/** The axes in their order: X across, Y down, Z as pages. */
export const GRID_AXES = ["X", "Y", "Z"] as const;
/**
 * The most cells one grid queues: 200 renders is a long night on a PC and real money on a pod, and a board larger than
 * that cannot be read. A larger one is refused with its count rather than cut.
 */
export const GRID_MOST = 200;
/** The axis that searches the prompt for its first value and puts each value in its place (A1111's Prompt S/R). */
export const PROMPT_SR = "sr";
/** An axis on the weight of one LoRA of a list: `lora:<list id>:<file>`. */
const LORA = "lora:";

/** One axis as the form keeps it: the setting, and its values as typed. An empty field is an axis not used. */
export interface GridAxis {
  field: string;
  values: string;
}

/** What a draft keeps of its grid: the axes as typed, X then Y then Z. */
export interface GridSetup {
  axes: GridAxis[];
}

/** How an axis's values are read. */
export type GridKind = "number" | "seed" | "choice" | "toggle" | "model" | "size" | "sr" | "lora";

/** A setting a grid can run along, as the field picker lists it. */
export interface GridField {
  id: string;
  label: string;
  group: "Prompt" | "Model" | "Sampling" | "Output" | "Settings";
  kind: GridKind;
  /** The input the values go to (for a LoRA's weight, its list). */
  input: string;
}

/** An axis worked out: its setting, the values it sends, and how each is said on the board. */
export interface GridAxisValues {
  field: string;
  label: string;
  values: unknown[];
  labels: string[];
}

/** Where a cell is on the board: its column (X), row (Y) and page (Z), each 0 when the axis is not used. */
export interface GridCell {
  x: number;
  y: number;
  z: number;
}

/**
 * Another family's form of the same operation (card #294), which the Model axis may run across, as A1111's checkpoint axis
 * does but across architectures: the same prompt on SDXL, Krea 2 and Klein as one board. Its recipe, the family's name as
 * the values and the board say it ("Klein: flux-2-klein-4b"), and the files its model input offers on the machines.
 */
export interface GridFamily {
  recipe: { id: string; family: string; inputs: readonly InputSpec[] };
  name: string;
  files: readonly string[];
}

/** What a Model axis may run across: the base form's family's name, and the other families' forms of its operation. */
export interface GridAcross {
  name: string;
  families: readonly GridFamily[];
}

/** A Model axis's value on another family: that family's form and the file its model input takes. */
interface AcrossValue {
  recipe: string;
  file: string;
}
const isAcross = (v: unknown): v is AcrossValue => typeof v === "object" && v !== null && typeof (v as AcrossValue).recipe === "string" && typeof (v as AcrossValue).file === "string";

/**
 * The other families' forms of the same operation as this one, one per family (a built-in one before an imported workflow
 * of it): what a Model axis may run across. None for a form that says no operation, or one of its own (a variation).
 */
export function sameOpForms<R extends { id: string; family: string; op?: PictureOp; hidden?: true; imported?: true; inputs: readonly InputSpec[] }>(base: { family: string; op?: PictureOp }, recipes: readonly R[]): R[] {
  if (!base.op || base.op === "own") return [];
  const out = new Map<string, R>();
  for (const r of recipes) {
    if (r.family === base.family || r.op !== base.op || r.hidden || !formModelInput(r)) continue;
    const had = out.get(r.family);
    if (!had || (had.imported && !r.imported)) out.set(r.family, r);
  }
  return [...out.values()];
}

/**
 * What a cell on another family starts with (card #294): what the picture is made from and about, as a model switch takes
 * it to another family (carryAcross: its pictures, its prompt, its boxes), with its size and its seed where that form has
 * them alike; never how the first model was run (its file, its LoRAs, its steps and CFG), which are the other family's own,
 * filled as a job sent without a form is (Queue.renderJob: its file's line, its defaults). The prompt goes whatever the
 * two forms' styles (SDXL's tags into Klein's sentences), and a text of the same name (the negative) with it: the same
 * prompt on every model is what the axis is for, as A1111's checkpoint axis keeps it.
 */
export function acrossInput(from: { inputs: readonly InputSpec[] }, to: { inputs: readonly InputSpec[] }, base: Record<string, unknown>): Record<string, unknown> {
  const out = carryAcross(from, to, base, undefined);
  const alike = carryOver({ inputs: [...from.inputs] }, { inputs: [...to.inputs] }, base, undefined);
  for (const i of to.inputs) if ((i.type === "size" || i.type === "seed") && alike[i.id] !== undefined) out[i.id] ??= alike[i.id];
  const said = (inputs: readonly InputSpec[]) => inputs.find((i) => i.type === "prompt" && !i.optional);
  const [a, b] = [said(from.inputs), said(to.inputs)];
  if (a && b && typeof base[a.id] === "string") out[b.id] ??= base[a.id];
  for (const i of to.inputs) {
    if (i.type !== "prompt" || i === b) continue;
    const was = from.inputs.find((o) => o.id === i.id && o.type === "prompt" && o !== a);
    if (was && typeof base[was.id] === "string") out[i.id] ??= base[was.id];
  }
  return out;
}

const groupOf = (spec: InputSpec): GridField["group"] => (spec.section === "speed" ? "Sampling" : spec.section === "out" ? "Output" : "Settings");

/**
 * The settings a grid can run along on this form: Prompt S/R when it has a text, its models, each LoRA of its lists by its
 * weight, its numbers, choices, switches and sizes, and the seed. What the app fills itself (`internal`) and a LoRA row the
 * recipe adds (`inList`, drawn in its list) are not offered; pictures, clips and texts are not values one runs along.
 */
export function gridFields(specs: readonly InputSpec[], values: Record<string, unknown>): GridField[] {
  const out: GridField[] = [];
  const prompt = specs.find((s) => s.type === "prompt" && !s.internal);
  if (prompt) out.push({ id: PROMPT_SR, label: "Prompt S/R", group: "Prompt", kind: "sr", input: prompt.id });
  for (const spec of specs) {
    if (spec.internal || spec.inList) continue;
    if (spec.type === "model") out.push({ id: spec.id, label: spec.label, group: "Model", kind: "model", input: spec.id });
    if (spec.type === "loras") {
      const list = Array.isArray(values[spec.id]) ? (values[spec.id] as LoraValue[]) : [];
      for (const l of list) out.push({ id: `${LORA}${spec.id}:${l.file}`, label: `LoRA weight · ${modelStem(l.file)}`, group: "Model", kind: "lora", input: spec.id });
    }
  }
  for (const spec of specs) {
    if (spec.internal || spec.inList) continue;
    if (spec.type === "number") out.push({ id: spec.id, label: spec.label, group: groupOf(spec), kind: "number", input: spec.id });
    if (spec.type === "choice") out.push({ id: spec.id, label: spec.label, group: groupOf(spec), kind: "choice", input: spec.id });
    if (spec.type === "toggle") out.push({ id: spec.id, label: spec.label, group: groupOf(spec), kind: "toggle", input: spec.id });
    if (spec.type === "size") out.push({ id: spec.id, label: spec.label, group: "Output", kind: "size", input: spec.id });
    if (spec.type === "seed") out.push({ id: spec.id, label: spec.label, group: "Output", kind: "seed", input: spec.id });
  }
  return out;
}

/** The field of an axis on this form, or undefined when the form has no such setting (a LoRA taken out of the list). */
export const gridField = (specs: readonly InputSpec[], values: Record<string, unknown>, id: string): GridField | undefined => gridFields(specs, values).find((f) => f.id === id);

/**
 * The values of an axis as typed, split as A1111 splits them: by commas, a value in double quotes keeping its commas
 * ("a red, worn coat"). Blank values are dropped.
 */
export function splitValues(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      // a doubled quote inside quotes is one quote, as in a CSV line
      if (quoted && text[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim()).filter(Boolean);
}

// A1111's ranges: "1-5", "1-10 (+2)", "10-1 (-3)", and "0-1 [5]" (five values from 0 to 1, both ends in)
const RANGE = /^([+-]?\d+(?:\.\d+)?)\s*-\s*([+-]?\d+(?:\.\d+)?)(?:\s*\(\s*([+-]?\d+(?:\.\d+)?)\s*\))?$/;
const COUNT = /^([+-]?\d+(?:\.\d+)?)\s*-\s*([+-]?\d+(?:\.\d+)?)\s*\[\s*(\d+)\s*\]$/;
/** Float sums drift (0.1 + 0.2): a value of a range is rounded to what was typed and a little more. */
const tidy = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Numbers as typed: single values and A1111's ranges, both ends in. `whole`: the setting takes whole numbers (steps, a seed),
 * a count range's values rounded to them. A range of more values than a grid takes is refused rather than read in full.
 */
export function parseNumbers(text: string, whole = false): { values: number[] } | { error: string } {
  const values: number[] = [];
  for (const part of splitValues(text)) {
    const count = COUNT.exec(part);
    const range = count ? null : RANGE.exec(part);
    if (count) {
      const [a, b, n] = [Number(count[1]), Number(count[2]), Number(count[3])];
      if (n < 1 || n > GRID_MOST) return { error: `“${part}”: 1 to ${GRID_MOST} values` };
      for (let i = 0; i < n; i++) values.push(n === 1 ? a : whole ? Math.round(a + ((b - a) * i) / (n - 1)) : tidy(a + ((b - a) * i) / (n - 1)));
    } else if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      const step = range[3] !== undefined ? Number(range[3]) : b >= a ? 1 : -1;
      if (step === 0 || (b - a) * step < 0) return { error: `“${part}”: the step goes the wrong way` };
      const n = Math.floor(tidy((b - a) / step)) + 1;
      if (n > GRID_MOST) return { error: `“${part}” is ${n} values, ${GRID_MOST} at most` };
      for (let i = 0; i < n; i++) values.push(tidy(a + step * i));
    } else {
      const n = Number(part);
      if (!part || !Number.isFinite(n)) return { error: `“${part}” is not a number` };
      values.push(n);
    }
  }
  return { values };
}

const ON = new Set(["on", "true", "yes", "1"]);
const OFF = new Set(["off", "false", "no", "0"]);

/**
 * The option a typed value means, as A1111 finds a checkpoint: the same value or label (case ignored), else the one option
 * whose name holds it. Null when none or several do.
 */
export function matchOption(typed: string, options: readonly string[], labels?: Record<string, string>): string | null {
  const t = typed.toLowerCase();
  const same = options.find((o) => o.toLowerCase() === t || labels?.[o]?.toLowerCase() === t || modelStem(o).toLowerCase() === t);
  if (same) return same;
  const holding = options.filter((o) => o.toLowerCase().includes(t) || labels?.[o]?.toLowerCase().includes(t));
  return holding.length === 1 ? holding[0]! : null;
}

/**
 * An axis's values worked out on this form: what each cell sends and how the board says it. `options`: the lists the form
 * offers by input id (a model's files, a sampler's names); a list not known takes what is typed as it is (the queue refuses
 * a file no machine has). An error says the first value that cannot be read.
 */
export function axisValues(specs: readonly InputSpec[], values: Record<string, unknown>, axis: GridAxis, options: Record<string, readonly string[]> = {}, across?: GridAcross): { axis: GridAxisValues } | { error: string } {
  const field = gridField(specs, values, axis.field);
  if (!field) return { error: "this setting is not on the form" };
  const spec = specs.find((s) => s.id === field.input)!;
  const typed = splitValues(axis.values);
  if (!typed.length) return { error: "no values" };
  const done = (vals: unknown[], labels: string[]) => ({ axis: { field: field.id, label: field.label, values: vals, labels } });
  switch (field.kind) {
    case "sr": {
      // A1111's rule: the first value is what is searched, and it must be there, else every cell would be the same picture
      const texts = specs.filter((s) => s.type === "prompt").map((s) => String(values[s.id] ?? ""));
      if (!texts.some((t) => t.includes(typed[0]!))) return { error: `“${typed[0]}” is not in the prompt: the first value is what each value replaces` };
      // each text as a cell would make it, measured before any cell is: a short value found in a long prompt, put in place
      // a thousand times over a 100-seed axis, made gigabytes of cells before the queue's own limit was ever asked
      const from = typed[0]!;
      for (const v of typed) {
        const long = texts.some((t) => t.length + (t.split(from).length - 1) * (v.length - from.length) > PROMPT_MOST);
        if (long) return { error: `“${v.slice(0, 40)}”: put in place of each “${from.slice(0, 40)}”, the prompt would be past ${PROMPT_MOST.toLocaleString("en-US")} characters` };
      }
      return done(typed, typed);
    }
    case "number":
    case "lora":
    case "seed": {
      const whole = field.kind === "seed" || (spec.type === "number" && Number.isInteger(spec.step) && Number.isInteger(spec.min));
      const read = parseNumbers(axis.values, whole);
      if ("error" in read) return read;
      // a setting of whole numbers takes no fraction: "20-30 (+2.5)" said 5 values and their cost, then failed at Queue grid
      if (whole) {
        const part = read.values.find((n) => !Number.isInteger(n));
        if (part !== undefined) return { error: `${part}: ${field.label} takes whole numbers` };
      }
      if (field.kind === "seed") {
        const bad = read.values.find((n) => !Number.isInteger(n) || n < 0 || n >= SEED_RANGE);
        if (bad !== undefined) return { error: `seed ${bad}: a whole number from 0 to ${SEED_RANGE - 1}` };
      }
      if (spec.type === "number") {
        // 0 is taken below `min` where it means "the recipe picks it" (auto)
        const bad = read.values.find((n) => (n < spec.min && !(spec.auto && n === 0)) || n > spec.max);
        if (bad !== undefined) return { error: `${bad} is outside ${spec.min} to ${spec.max}` };
      }
      return done(read.values, read.values.map(String));
    }
    case "toggle": {
      const vals: boolean[] = [];
      for (const t of typed) {
        if (ON.has(t.toLowerCase())) vals.push(true);
        else if (OFF.has(t.toLowerCase())) vals.push(false);
        else return { error: `“${t}”: on or off` };
      }
      const caps = spec.type === "toggle" ? spec.captions : undefined;
      return done(vals, vals.map((v) => (caps ? (v ? caps.on : caps.off) : v ? "on" : "off")));
    }
    case "model":
      if (across?.families.length && spec.id === formModelInput({ inputs: specs })?.id) return acrossValues(field, typed, options[spec.id] ?? [], across);
    // falls through: a model of the form's own family only
    case "choice": {
      const own = spec.type === "choice" && Array.isArray(spec.options) ? [...(spec.extra ?? []), ...spec.options] : [];
      const list = options[spec.id]?.length ? options[spec.id]! : own;
      const labels = spec.type === "choice" ? spec.labels : undefined;
      const vals: string[] = [];
      for (const t of typed) {
        const hit = list.length ? matchOption(t, list, labels) : t;
        if (!hit) return { error: `“${t}” is not one of ${spec.label}'s ${field.kind === "model" ? "files" : "options"}, or matches several` };
        vals.push(hit);
      }
      return done(vals, vals.map((v) => (field.kind === "model" ? modelStem(v) : labels?.[v] ?? v)));
    }
    case "size": {
      if (spec.type !== "size") return { error: "this setting is not a size" };
      const vals: Array<{ width: number; height: number }> = [];
      for (const t of typed) {
        const shape = spec.shapes.find((s) => s.id.toLowerCase() === t.toLowerCase() || s.label.toLowerCase() === t.toLowerCase());
        const wh = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(t);
        const size = shape ? { width: shape.width, height: shape.height } : wh ? { width: Number(wh[1]), height: Number(wh[2]) } : null;
        if (!size) return { error: `“${t}”: a shape's name or W×H` };
        if (!spec.ratioOnly && (size.width % spec.grid || size.height % spec.grid || Math.min(size.width, size.height) < spec.min || Math.max(size.width, size.height) > spec.max)) {
          return { error: `${size.width}×${size.height}: multiples of ${spec.grid}, ${spec.min} to ${spec.max}` };
        }
        // past the pixels the model draws, the form sends it smaller (inputs.ts): a cell said 2048×2048 was rendered at
        // 1024×1024, the same picture as its neighbour, and paid twice
        const most = !spec.ratioOnly ? spec.maxPixels : undefined;
        const sent = most ? withinPixels(size, { grid: spec.grid, maxPixels: most, min: spec.min }) : size;
        if (sent.width !== size.width || sent.height !== size.height) return { error: `${size.width}×${size.height} is more than this model draws: it would be sent as ${sent.width}×${sent.height}` };
        vals.push(size);
      }
      return done(vals, vals.map((v) => `${v.width}×${v.height}`));
    }
  }
}

/**
 * A Model axis that may run across families (card #294): a value is a file of the form's own list, as before, else of one
 * other family's; "Klein: 4b" says the family first, for a file that more than one family lists (their folders are often
 * one). Each is said with its family once any value is of another, so that the board tells the cells apart.
 */
function acrossValues(field: GridField, typed: readonly string[], own: readonly string[], across: GridAcross): { axis: GridAxisValues } | { error: string } {
  const named = (t: string): GridFamily | "own" | null => {
    const n = squash(t);
    if (!n) return null;
    if (squash(across.name) === n) return "own";
    const same = across.families.filter((f) => squash(f.name) === n || squash(f.recipe.family) === n);
    if (same.length === 1) return same[0]!;
    const starts = across.families.filter((f) => squash(f.name).startsWith(n));
    return starts.length === 1 ? starts[0]! : null;
  };
  const vals: Array<string | AcrossValue> = [];
  for (const t of typed) {
    // "Family: file"; a file name with a colon in it (rare: Windows forbids it) is a plain value when what is before it names no family
    const at = t.indexOf(":");
    const family = at > 0 ? named(t.slice(0, at)) : null;
    const file = family ? t.slice(at + 1).trim() : t;
    if (family === "own" || (!family && (!own.length || matchOption(file, own)))) {
      const hit = own.length ? matchOption(file, own) : file;
      if (!hit) return { error: `“${file}” is not one of ${across.name}'s files, or matches several` };
      vals.push(hit);
      continue;
    }
    if (family) {
      const hit = family.files.length ? matchOption(file, family.files) : file;
      if (!hit) return { error: `“${file}” is not one of ${family.name}'s files, or matches several` };
      vals.push({ recipe: family.recipe.id, file: hit });
      continue;
    }
    // no family said and none of the form's own: the one other family that has it
    const found = across.families.flatMap((f) => {
      const hit = matchOption(file, f.files);
      return hit ? [{ f, hit }] : [];
    });
    if (found.length !== 1) return { error: found.length ? `“${t}” is a file of ${found.map((x) => x.f.name).join(" and ")}: write it as ${found[0]!.f.name}: ${t}` : `“${t}” is not one of ${field.label}'s files, nor another family's, or matches several` };
    vals.push({ recipe: found[0]!.f.recipe.id, file: found[0]!.hit });
  }
  const crosses = vals.some(isAcross);
  const nameOf = (id: string) => across.families.find((f) => f.recipe.id === id)?.name ?? id;
  const labels = vals.map((v) => (isAcross(v) ? `${nameOf(v.recipe)}: ${modelStem(v.file)}` : crosses ? `${across.name}: ${modelStem(v)}` : modelStem(v)));
  return { axis: { field: field.id, label: field.label, values: vals, labels } };
}

/** The forms of other families a set-up's cells render on (card #294): those its Model axis's values name. */
const acrossOf = (axes: readonly GridAxisValues[], across: GridAcross | undefined): GridFamily[] => {
  const ids = new Set(axes.flatMap((a) => a.values.filter(isAcross).map((v) => v.recipe)));
  return (across?.families ?? []).filter((f) => ids.has(f.recipe.id));
};

/** The axes in use of a set-up, worked out: those with a field and values, in order; the first that cannot be read refuses the grid. */
export function gridAxes(specs: readonly InputSpec[], values: Record<string, unknown>, setup: GridSetup, options: Record<string, readonly string[]> = {}, across?: GridAcross): { axes: GridAxisValues[] } | { error: string; axis: number } {
  const axes: GridAxisValues[] = [];
  const seen = new Set<string>();
  const used = setup.axes.slice(0, GRID_AXES.length);
  for (const [i, a] of used.entries()) {
    // an axis left empty before one in use keeps its place (X and Z with no Y: Z stays the pages), as one value of nothing
    if (!a.field) {
      if (used.slice(i + 1).some((b) => b.field)) axes.push({ field: "", label: "", values: [null], labels: [""] });
      continue;
    }
    if (seen.has(a.field)) return { error: "this setting is on another axis already", axis: i };
    seen.add(a.field);
    const read = axisValues(specs, values, a, options, across);
    if ("error" in read) return { error: read.error, axis: i };
    axes.push(read.axis);
  }
  // across families, every other axis runs on each family's form too: read there as here, or the grid is refused before
  // anything is priced (a LoRA's weight, a setting that form has not, a size it does not draw)
  for (const f of acrossOf(axes, across)) {
    const carried = acrossInput({ inputs: specs }, f.recipe, values);
    for (const [i, a] of used.entries()) {
      if (!a.field || axes[i]?.values.some(isAcross)) continue;
      if (a.field.startsWith(LORA)) return { error: `a LoRA's weight cannot run across families: the LoRAs are ${across!.name}'s`, axis: i };
      const read = axisValues(f.recipe.inputs, carried, a);
      if ("error" in read) return { error: `${f.name}: ${read.error === "this setting is not on the form" ? `${axes[i]?.label ?? a.field} is not on its form` : read.error}`, axis: i };
    }
  }
  const n = gridCount(axes);
  if (n > GRID_MOST) return { error: `${n} renders, ${GRID_MOST} at most in one grid`, axis: axes.length - 1 };
  return { axes };
}

/** How many renders the axes make: every combination of their values. */
export const gridCount = (axes: ReadonlyArray<{ values: readonly unknown[] }>): number => (axes.length ? axes.reduce((n, a) => n * a.values.length, 1) : 0);

/** The count as the Grid card says it: "3 × 4 × 2 = 24 renders". */
export const gridCountSaid = (axes: ReadonlyArray<{ field?: string; values: readonly unknown[] }>): string => {
  const n = gridCount(axes);
  // an axis kept only for its place says nothing
  const shown = axes.filter((a) => a.field !== "");
  return shown.length > 1 ? `${shown.map((a) => a.values.length).join(" × ")} = ${plural(n, "render")}` : plural(n, "render");
};

/** Every cell of the axes, in the order they are queued: page by page, row by row, left to right (as A1111 renders them). */
export function gridCells(axes: ReadonlyArray<{ values: readonly unknown[] }>): GridCell[] {
  const [nx, ny, nz] = [axes[0]?.values.length ?? 1, axes[1]?.values.length ?? 1, axes[2]?.values.length ?? 1];
  const out: GridCell[] = [];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) out.push({ x, y, z });
  return out;
}

/**
 * The form one cell renders: the base form with each axis's value of the cell put in. A seed the form draws anew for every
 * render is drawn once here for the whole grid (`seed`), as A1111 does, so that the cells differ by their axes alone; a seed
 * axis gives each cell its own. Prompt S/R puts its value in place of the first value in every text of the form.
 */
export function cellInput(specs: readonly InputSpec[], base: Record<string, unknown>, axes: readonly GridAxisValues[], cell: GridCell, seed: number): Record<string, unknown> {
  const input: Record<string, unknown> = { ...base };
  const seedSpec = specs.find((s) => s.type === "seed");
  if (seedSpec && (typeof input[seedSpec.id] !== "number" || input[seedSpec.id] === RANDOM_SEED || (input[seedSpec.id] as number) < 0)) input[seedSpec.id] = seed;
  const at = [cell.x, cell.y, cell.z];
  for (const [i, axis] of axes.entries()) {
    const value = axis.values[at[i]!];
    if (!axis.field) continue;
    if (axis.field === PROMPT_SR) {
      const from = String(axis.values[0]);
      for (const s of specs) if (s.type === "prompt" && typeof input[s.id] === "string") input[s.id] = (input[s.id] as string).split(from).join(String(value));
    } else if (axis.field.startsWith(LORA)) {
      const [list, ...file] = axis.field.slice(LORA.length).split(":");
      const name = file.join(":");
      const rows = Array.isArray(input[list!]) ? (input[list!] as LoraValue[]) : [];
      input[list!] = rows.map((r) => (r.file === name ? { ...r, weight: value as number } : r));
    } else input[axis.field] = value;
  }
  return input;
}

/** One cell of a grid as it is queued and priced: its place, the form it renders (on its recipe), and its name. */
export interface GridJob {
  cell: GridCell;
  /** Its place as the board keys it: "x.y.z". */
  key: string;
  /** The recipe it renders on: the grid's own, or another family's form of the same operation (card #294). */
  recipe: string;
  input: Record<string, unknown>;
  label: string;
}

/**
 * Every cell of the axes with the form it renders (cellInput) and its name (cellSaid), in the order they are queued: what
 * is priced before queuing is what is queued (the cost of each cell's own steps, size and model), with the one seed
 * drawn for the grid. A cell whose Model axis value is another family's renders on that family's form (card #294).
 */
export function gridJobs(recipe: { id: string; inputs: readonly InputSpec[] }, base: Record<string, unknown>, axes: readonly GridAxisValues[], seed: number, across?: GridAcross): GridJob[] {
  const others = new Map(acrossOf(axes, across).map((f) => [f.recipe.id, f.recipe]));
  return gridCells(axes).map((cell) => {
    const key = `${cell.x}.${cell.y}.${cell.z}`;
    const at = [cell.x, cell.y, cell.z];
    const i = axes.findIndex((a, k) => isAcross(a.values[at[k]!]));
    const on = i < 0 ? undefined : (axes[i]!.values[at[i]!] as AcrossValue);
    const other = on && others.get(on.recipe);
    if (!other) return { cell, key, recipe: recipe.id, input: cellInput(recipe.inputs, base, axes, cell, seed), label: cellSaid(axes, cell) };
    // on another family: its form started from this one (acrossInput), then every axis put in as here, the Model axis's
    // value being the file of that form's own model input
    const model = formModelInput({ inputs: other.inputs })!.id;
    const there = axes.map((a, k) => (k === i ? { ...a, field: model, values: a.values.map((v) => (isAcross(v) ? v.file : v)) } : a));
    return { cell, key, recipe: other.id, input: cellInput(other.inputs, acrossInput(recipe, other, base), there, cell, seed), label: cellSaid(axes, cell) };
  });
}

/** What one cell is said as, its axes' values in order ("30 · blue coat · 5678"): a cell's name in the library and its banners. */
export const cellSaid = (axes: ReadonlyArray<{ labels: readonly string[] }>, cell: GridCell): string =>
  axes.map((a, i) => a.labels[[cell.x, cell.y, cell.z][i]!]).filter(Boolean).join(" · ");

/** Above this estimate (USD) a grid on a rented pod is asked about before it is queued (the owner: "above a few dollars"). */
export const GRID_ASK_USD = 3;

/**
 * Whether a grid is asked about before it is queued, and why: only on a rented pod (a ComfyUI of the user's own costs
 * nothing per render), when its estimate is above GRID_ASK_USD, when it would reach a spending cap (a cap of 0 is none),
 * or when its cost cannot be told at all, which is never passed over in silence. Null: it is queued at once, its count and
 * cost having been said on the card.
 */
export function gridAsks(cost: { onPod: boolean; usd: number | null }, spend: CapsSpent | null): string | null {
  if (!cost.onPod) return null;
  if (cost.usd === null) return "Its cost on the pod cannot be told yet (no render of this model there to go by).";
  // the caps' own rule, as an MCP token's deploy is held to it (rentedBilling.ts noRoomFor)
  const full = spend ? capRoom(spend, cost.usd) : null;
  if (full) return `It would reach a spending cap: ${full}.`;
  if (cost.usd > GRID_ASK_USD) return `About ${usd(cost.usd)} on the pod.`;
  return null;
}
