import type { Clip, ClipPatch } from "../api";

/**
 * What the timeline's Needs attention card lists, each row with the one action that mends it, and Fix all: every
 * row's action at once. Read by the Overview; kept apart so that all of it is tested without a browser.
 */

/** Past ×3 a join shows: its figure as it plays, or the run-up's end (the model stepped away from its guide). */
export const SHOWS = 3;

/** How each take of a clip meets the clip before (`in`) and after (`out`), as the server measures it. */
export type JoinFigures = Array<{ take: string; in: number | null; out: number | null }>;

/**
 * A row's action: render clips, make another take play, fill the frame, or open a clip whose form is still to fill
 * (with what it waits for), so that every row has a button and none reads as a dead end.
 */
export type Act =
  | { do: "render"; clips: string[]; ms: number }
  | { do: "take"; clip: string; take: string; number: number; figure: number }
  | { do: "fill"; clips: string[] }
  | { do: "open"; clip: string; why: string };

export interface Row {
  key: string;
  kind: "missing" | "stale" | "failed" | "join" | "shape";
  ids: string[];
  warn: boolean;
  /** A join row's figure: the worse of the join and the run-up's end. */
  figure?: number;
  /** A failed row's reasons, one per clip. */
  reasons?: Array<{ clip: string; why: string }>;
  act?: Act;
}

/** Every row's action as one run: the patches first (a take made to play, the frame filled), then one render of each clip left. */
export interface Fix {
  patches: Array<{ clip: string; patch: ClipPatch }>;
  render: string[];
  ms: number;
}

export function attention(clips: Clip[], o: {
  /** Every take's join figures, per clip that flows on and has a take; undefined while measuring. */
  joins: Map<string, JoinFigures | undefined>;
  /** A video clip with its form filled, not already in the queue. */
  renderable(c: Clip): boolean;
  msOf(c: Clip): number | null;
  /** Of another shape than the video, shown with bars. */
  misfit(c: Clip): boolean;
  /** Why a clip cannot be rendered yet ("Write prompt first."), when its form is still to fill. */
  why?(c: Clip): string | undefined;
}): Row[] {
  const render = (list: Clip[]): Act | undefined => {
    const can = list.filter(o.renderable);
    return can.length ? { do: "render", clips: can.map((c) => c.id), ms: can.reduce((sum, c) => sum + (o.msOf(c) ?? 0), 0) } : undefined;
  };
  const rows: Row[] = [];
  // a failed clip is listed once, as failed: Retry is its action; one with its form still to fill is listed, not rendered
  const unrendered = clips.filter((c) => c.kind === "video" && !c.take && !c.job && !c.failed);
  if (unrendered.length) {
    // none of them can render yet: the first one's form is opened, said with what it waits for
    const waiting = o.why && unrendered.map((c) => ({ clip: c.id, why: o.why!(c) })).find((x) => x.why);
    const act = render(unrendered) ?? (waiting ? { do: "open" as const, clip: waiting.clip, why: waiting.why! } : undefined);
    rows.push({ key: "missing", kind: "missing", ids: unrendered.map((c) => c.id), warn: false, act });
  }
  const stale = clips.filter((c) => c.join === "stale");
  if (stale.length) rows.push({ key: "stale", kind: "stale", ids: stale.map((c) => c.id), warn: true, act: render(stale) });
  const failed = clips.filter((c) => c.failed && !c.take);
  if (failed.length) rows.push({ key: "failed", kind: "failed", ids: failed.map((c) => c.id), warn: true, reasons: failed.map((c) => ({ clip: c.id, why: c.failed! })), act: render(failed) });
  clips.forEach((c, i) => {
    if (i === 0 || c.joined !== "continue" || !c.take || c.join === "stale") return;
    const items = o.joins.get(c.id);
    const figure = items?.find((j) => j.take === c.take!.id)?.in ?? null;
    const carry = c.take.measure?.handover ?? null;
    const worst = Math.max(figure ?? 0, carry ?? 0);
    if (worst <= SHOWS) return;
    // another take that comes in under ×3 (its run-up's end too), the smoothest of them; measuring still: no action yet
    let better: Extract<Act, { do: "take" }> | null = null;
    for (const [k, t] of c.takes.entries()) {
      const v = items?.find((j) => j.take === t.id)?.in ?? null;
      if (t.id !== c.take.id && v !== null && v <= SHOWS && (t.measure?.handover ?? 0) <= SHOWS && (!better || v < better.figure)) better = { do: "take", clip: c.id, take: t.id, number: k + 1, figure: v };
    }
    const act = !items ? undefined : better ?? render([c]);
    rows.push({ key: `join:${c.id}`, kind: "join", ids: [c.id], warn: true, figure: worst, act });
  });
  const wrong = clips.filter(o.misfit);
  if (wrong.length) rows.push({ key: "shape", kind: "shape", ids: wrong.map((c) => c.id), warn: false, act: { do: "fill", clips: wrong.map((c) => c.id) } });
  return rows;
}

/** Fix all, once two rows or more have an action: each clip rendered once, in timeline order, after the patches. */
export function fixAll(rows: Row[], clips: Clip[], msOf: (c: Clip) => number | null): Fix | null {
  // opening a form mends nothing by itself: it is left out of Fix all, and does not count towards showing it
  const acts = rows.flatMap((r) => (r.act && r.act.do !== "open" ? [r.act] : []));
  if (acts.length < 2) return null;
  const patches: Fix["patches"] = [];
  const wanted = new Set<string>();
  for (const a of acts) {
    if (a.do === "take") patches.push({ clip: a.clip, patch: { take: a.take } });
    else if (a.do === "fill") for (const clip of a.clips) patches.push({ clip, patch: { fill: true } });
    else if (a.do === "render") for (const clip of a.clips) wanted.add(clip);
  }
  const render = clips.filter((c) => wanted.has(c.id));
  return { patches, render: render.map((c) => c.id), ms: render.reduce((sum, c) => sum + (msOf(c) ?? 0), 0) };
}

/**
 * The server's plan of the clips left to render, as the header's Render all says it: on Auto (`auto`) they are shared
 * between the machines, each loading its model once, so each clip's own time added up says too much (2 Wan clips on 3
 * machines read ~4 min in Needs attention and ~2 min in the header). `ids`: the clips it was asked for; `ms`: 0 while unknown.
 */
export interface Plan {
  auto: boolean;
  ids: string[];
  ms: number;
}

const sameClips = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * The clips whose time is to be asked of the server's plan: every render the rows and Fix all offer, each set once, but
 * the header's own (its plan is known) and none when a machine is picked (one machine renders them one after another:
 * added up is right).
 */
export function plansToAsk(rows: Row[], fix: Fix | null, plan: Plan | undefined): string[][] {
  if (!plan?.auto) return [];
  const sets = [...rows.flatMap((r) => (r.act?.do === "render" ? [r.act.clips] : [])), ...(fix?.render.length ? [fix.render] : [])];
  const out: string[][] = [];
  for (const s of sets) if (!sameClips(s, plan.ids) && !out.some((o) => sameClips(o, s))) out.push(s);
  return out;
}

/**
 * The rows and Fix all with each render's time as the server plans it: the header's plan for its own clips, what was
 * asked (`asked`, by clip ids as plansToAsk gave them) for the others; added up still while the plan is not known.
 */
export function withPlans(rows: Row[], fix: Fix | null, plan: Plan | undefined, asked: Array<{ ids: string[]; ms: number | null | undefined }>): { rows: Row[]; fix: Fix | null } {
  const planned = (ids: string[], summed: number) => {
    if (!plan?.auto) return summed;
    const ms = sameClips(ids, plan.ids) ? plan.ms : asked.find((a) => sameClips(a.ids, ids))?.ms;
    return ms ? ms : summed;
  };
  return {
    rows: rows.map((r) => (r.act?.do === "render" ? { ...r, act: { ...r.act, ms: planned(r.act.clips, r.act.ms) } } : r)),
    fix: fix && fix.render.length ? { ...fix, ms: planned(fix.render, fix.ms) } : fix,
  };
}

/**
 * A row set aside ("keep as it is": the smoother take was not the better one, the clip is not in the cut): what it is
 * and the take each of its clips plays. Another take, or a new render, is another decision: the row comes back.
 * A clip with nothing rendered is never set aside: there is nothing to keep.
 */
export const canDismiss = (r: Row) => r.kind !== "missing";
export const dismissKey = (r: Row, clips: Clip[]) => `${r.kind}:${r.ids.map((id) => `${id}@${clips.find((c) => c.id === id)?.take?.id ?? "-"}`).join(",")}`;

/** One row's action as Fix all runs it: its patches, then its render. Opening a form is not one: null. */
export function fixOf(a: Act): Omit<Fix, "ms"> | null {
  if (a.do === "render") return { patches: [], render: a.clips };
  if (a.do === "take") return { patches: [{ clip: a.clip, patch: { take: a.take } }], render: [] };
  if (a.do === "fill") return { patches: a.clips.map((clip) => ({ clip, patch: { fill: true } })), render: [] };
  return null;
}

/**
 * What "Fix all first" runs from the Export and Finish dialogs, as the command bar's Fix all does: Fix all once it is
 * offered, else the one row's own action when only one row has one; null when nothing listed has an action that mends it.
 */
export function planFix(rows: Row[], clips: Clip[], msOf: (c: Clip) => number | null): Omit<Fix, "ms"> | null {
  const fix = fixAll(rows, clips, msOf);
  if (fix) return fix;
  const acts = rows.flatMap((r) => {
    const f = r.act ? fixOf(r.act) : null;
    return f ? [f] : [];
  });
  return acts.length === 1 ? acts[0]! : null;
}

/** "clip 5", "clips 2 and 4", "clips 1, 2 and 6": clip numbers in words. */
export function clipWords(numbers: number[]): string {
  const n = [...numbers].sort((a, b) => a - b);
  if (n.length === 1) return `clip ${n[0]}`;
  return `clips ${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
}

/** Fix all's tip, as a sentence: what it changes (each its own Undo step), then what it renders, in timeline order. */
export function fixWords(fix: Omit<Fix, "ms">, clips: Clip[]): string {
  const number = (id: string) => clips.findIndex((c) => c.id === id) + 1;
  const takes = fix.patches.filter((p) => p.patch.take).map((p) => {
    const c = clips.find((x) => x.id === p.clip);
    return `take ${(c?.takes.findIndex((t) => t.id === p.patch.take) ?? -1) + 1} on clip ${number(p.clip)}`;
  });
  const filled = fix.patches.filter((p) => p.patch.fill).map((p) => number(p.clip));
  const parts = [
    ...(takes.length ? [`plays ${takes.join(", ")}`] : []),
    ...(filled.length ? [`fills the frame of ${clipWords(filled)}`] : []),
    ...(fix.render.length ? [`${fix.patches.length ? "then renders" : "renders"} ${clipWords(fix.render.map(number))}${fix.render.length > 1 ? ", in order" : ""}`] : []),
  ];
  const sentence = parts.join(", ");
  const undo = fix.patches.length ? ` Each change is its own Undo step.` : "";
  return sentence ? `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.${undo}` : "";
}

/**
 * Needs attention in one line, for the Export and Finish dialogs: "3 things need attention: clip 5 not rendered, joins at
 * clips 2 and 4". The joins are said together, the other rows each in a few words.
 */
export function attentionLine(rows: Row[], clips: Clip[]): string {
  if (!rows.length) return "";
  const number = (id: string) => clips.findIndex((c) => c.id === id) + 1;
  const nums = (r: Row) => r.ids.map(number);
  const said: string[] = [];
  const joins = rows.filter((r) => r.kind === "join").flatMap(nums);
  for (const r of rows) {
    if (r.kind === "join") {
      if (r === rows.find((x) => x.kind === "join")) said.push(`${joins.length === 1 ? "join at" : "joins at"} ${clipWords(joins)}`);
      continue;
    }
    const words = clipWords(nums(r));
    said.push(r.kind === "missing" ? `${words} not rendered` : r.kind === "stale" ? `${r.ids.length === 1 ? "clip" : "clips"} before ${words} changed` : r.kind === "failed" ? `${words} failed` : `${words} in another aspect ratio`);
  }
  return `${rows.length === 1 ? "1 thing needs" : `${rows.length} things need`} attention: ${said.join(", ")}`;
}
