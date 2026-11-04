import { RANDOM_SEED, type InputSpec, type LoraValue } from "./inputs";
import { usd } from "./money";
import { modelStem } from "./modelFiles";
import { SEED_RANGE } from "./seed";
import { plural } from "./text";

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
export function axisValues(specs: readonly InputSpec[], values: Record<string, unknown>, axis: GridAxis, options: Record<string, readonly string[]> = {}): { axis: GridAxisValues } | { error: string } {
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
      return done(typed, typed);
    }
    case "number":
    case "lora":
    case "seed": {
      const whole = field.kind === "seed" || (spec.type === "number" && Number.isInteger(spec.step) && Number.isInteger(spec.min));
      const read = parseNumbers(axis.values, whole);
      if ("error" in read) return read;
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
    case "choice":
    case "model": {
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
        vals.push(size);
      }
      return done(vals, vals.map((v) => `${v.width}×${v.height}`));
    }
  }
}

/** The axes in use of a set-up, worked out: those with a field and values, in order; the first that cannot be read refuses the grid. */
export function gridAxes(specs: readonly InputSpec[], values: Record<string, unknown>, setup: GridSetup, options: Record<string, readonly string[]> = {}): { axes: GridAxisValues[] } | { error: string; axis: number } {
  const axes: GridAxisValues[] = [];
  const seen = new Set<string>();
  for (const [i, a] of setup.axes.slice(0, GRID_AXES.length).entries()) {
    if (!a.field) continue;
    if (seen.has(a.field)) return { error: "this setting is on another axis already", axis: i };
    seen.add(a.field);
    const read = axisValues(specs, values, a, options);
    if ("error" in read) return { error: read.error, axis: i };
    axes.push(read.axis);
  }
  const n = gridCount(axes);
  if (n > GRID_MOST) return { error: `${n} renders, ${GRID_MOST} at most in one grid`, axis: axes.length - 1 };
  return { axes };
}

/** How many renders the axes make: every combination of their values. */
export const gridCount = (axes: ReadonlyArray<{ values: readonly unknown[] }>): number => (axes.length ? axes.reduce((n, a) => n * a.values.length, 1) : 0);

/** The count as the Grid card says it: "3 × 4 × 2 = 24 renders". */
export const gridCountSaid = (axes: ReadonlyArray<{ values: readonly unknown[] }>): string => {
  const n = gridCount(axes);
  return axes.length > 1 ? `${axes.map((a) => a.values.length).join(" × ")} = ${plural(n, "render")}` : plural(n, "render");
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
export function gridAsks(cost: { onPod: boolean; usd: number | null }, spend: { today: number; month: number; caps: { day: number; month: number } } | null): string | null {
  if (!cost.onPod) return null;
  if (cost.usd === null) return "Its cost on the pod cannot be told yet (no render of this model there to go by).";
  if (spend?.caps.day && spend.today + cost.usd >= spend.caps.day) return `It would reach today's spending cap (${usd(spend.today)} spent of ${usd(spend.caps.day)}, about ${usd(cost.usd)} more).`;
  if (spend?.caps.month && spend.month + cost.usd >= spend.caps.month) return `It would reach this month's spending cap (${usd(spend.month)} spent of ${usd(spend.caps.month)}, about ${usd(cost.usd)} more).`;
  if (cost.usd > GRID_ASK_USD) return `About ${usd(cost.usd)} on the pod.`;
  return null;
}
