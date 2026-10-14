import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Clip, Take, Timeline } from "../../api";
import { Chip, cx, Help } from "../../ui";
import { change, DRIFT, driftOf, sharpOf, driftWords, past, pct, runSeries, runTicks, signed, type RunPoint } from "../lookDrift";
import { SHOWS } from "../attention";

/**
 * How the take looks, measured on its own frames when it was rendered, and how far it has moved from the clip
 * before and from the first clip of the run it flows on from (clips joined one after the other). For catching a
 * chain that slides darker, softer, duller or slower; a few per cent is the model's own variation. Under it, the
 * run at a glance: sharpness and brightness over every clip of it (see lookDrift).
 */
export function LookTable({ timeline, index, take, onSelectClip }: { timeline: Timeline; index: number; take: Take; onSelectClip?(id: string): void }) {
  const [open, setOpen] = useState(false);
  const clips = timeline.clips;
  const m = take.measure!;
  const d = driftOf(clips, index);
  const before = d ? clips[d.before]?.take?.measure ?? null : null;
  const first = d ? clips[d.start]?.take?.measure ?? null : null;
  // one column when the clip before is the run's start: both say the same
  const cols = d
    ? d.same
      ? [{ head: `vs clip ${d.start + 1}`, tip: `Against clip ${d.start + 1}: the one before, and the first of this run`, of: first, by: d.whole }]
      : [{ head: `vs clip ${d.before + 1}`, tip: `Against clip ${d.before + 1}, the one before`, of: before, by: d.hop }, { head: `vs clip ${d.start + 1}`, tip: `Against clip ${d.start + 1}, the first of this run`, of: first, by: d.whole }]
    : [];
  const diff = (a: number | null | undefined, b: number | null | undefined, unit = "") => (a == null || b == null ? null : `${signed(a - b)}${unit}`);
  const share = (x: number | null) => (x == null ? null : pct(x));
  type Cell = { text: string | null; bad?: boolean };
  type Row = { label: string; value: string; vs: Cell[]; why: string; bad?: boolean };
  const each = (f: (c: (typeof cols)[number]) => Cell) => cols.map(f);
  const rows: Row[] = [
    { label: "Brightness", value: m.luma.toFixed(0), vs: each((c) => ({ text: share(c.by.luma), bad: past("luma", c.by.luma) })), why: "Mean luma of the frames, 0 to 255." },
    { label: "Sharpness", value: sharpOf(m).toFixed(2), vs: each((c) => ({ text: share(c.by.sharp), bad: past("sharp", c.by.sharp) })), why: m.edges != null ? "The edges of a small grey copy cleaned of its grain first (the mean absolute Laplacian): 0 is flat, several units is crisp. Grain is its own row: read as detail, a grainier clip looked sharper." : "The mean absolute Laplacian of a small grey copy: 0 is flat, several units is crisp. Grain counts in it (measured before the Grain figure existed)." },
  ];
  if (m.face != null) rows.push({ label: "Face", value: m.face.toFixed(2), vs: each((c) => ({ text: share(c.by.face), bad: past("face", c.by.face) })), why: `How much the face along the clip is the person it is of: a Motion transfer's Picture, an H3 clip's cast (ArcFace, the median of a few frames${m.faceLow != null ? `; the lowest ${m.faceLow.toFixed(2)}` : ""}). Against the clip before: past ${pct(DRIFT.face)}, the person drifted (render a new take). Small or turned faces read lower: compare along a run, not to a fixed bar.` });
  if (m.grain != null) rows.push({ label: "Grain", value: m.grain.toFixed(2), vs: each((c) => ({ text: share(c.by.grain), bad: past("grain", c.by.grain) })), why: `The fine noise: how far the pixels sit from a cleaned copy, in luma steps. A clip that carries on from a grainier one, then gets grain of its own, stacks it join after join; past ${pct(DRIFT.grain)} it shows.` });
  if (m.pace != null) rows.push({ label: "Pace", value: m.pace.toFixed(1), vs: each((c) => ({ text: share(c.by.pace), bad: past("pace", c.by.pace) })), why: `Mean frame-to-frame change, the ruler's motion figure. H3 tends to slow down after each hand-over; past ${pct(DRIFT.pace)} it reads as slow motion.` });
  if (m.chroma) rows.push({ label: "Colour", value: `${signed(m.chroma.u)} / ${signed(m.chroma.v)}`, vs: each((c) => ({ text: c.by.colour == null ? null : `±${c.by.colour.toFixed(1)}`, bad: past("colour", c.by.colour) })), why: `Mean chroma against neutral, as U / V: U is blue (+) to yellow (−), V red (+) to green (−). Against another clip: how far the colour moved in U/V; past ${DRIFT.colour} a cast shows. A warming or greying chain shows here.` });
  if (m.handover != null) rows.push({ label: "Run-up end", value: `×${m.handover.toFixed(1)}`, vs: each(() => ({ text: null })), bad: m.handover > DRIFT.handover, why: `A continuation: how much the picture jumps where the run-up (the frames shared with the clip before; in a seamless take, that clip's own frames) ends and this clip's own frames begin, against its own motion right after. ×1 carries on; past ×${SHOWS} the model stepped away from its guide and the join shows: render a new take.` });
  // the rest: read when something looks off, not every time
  const more: Row[] = [];
  if (m.range) more.push({ label: "Range", value: `${m.range.low.toFixed(0)}–${m.range.high.toFixed(0)}`, vs: each((c) => ({ text: c.of?.range ? diff(m.range!.high - m.range!.low, c.of.range.high - c.of.range.low) : null })), why: "Where the darkest and the brightest tenth of the picture sit. A shrinking range is crushed blacks or clipped whites." });
  if (m.flicker != null) more.push({ label: "Flicker", value: `${m.flicker.toFixed(1)} %`, vs: each((c) => ({ text: diff(m.flicker, c.of?.flicker, " pt") })), why: "How much the frame's mean brightness changes from one frame to the next. Exposure flicker is a known continuation artefact that averages hide." });
  if (m.voice != null) more.push({ label: "Voice", value: `${m.voice} Hz`, vs: each((c) => ({ text: share(change(m.voice, c.of?.voice)) })), why: "Where the sound's energy sits (its spectral centroid). A voice carried over several clips dulls before it changes: it drifts down." });
  if (m.drift) more.push({ label: "Run-up width", value: `×${m.drift.width.toFixed(3)}`, vs: each(() => ({ text: null })), why: "A join made in the latent: how wide the regenerated run-up came out against the latent it was guided by. 1.000 is the same; a chain of exact latents reads 1.02 to 1.05 at every hop, which is the drift." });
  const warning = driftWords(d);
  const n = clips[index]!.takes.findIndex((t) => t.id === take.id) + 1;
  const note = d
    ? `Measured on this take's own frames when it was rendered. "vs clip" is the change against that clip's take: the one before, and the first of this run (clip ${d.start + 1}); a few per cent is the model's own variation. Warned past ${pct(DRIFT.luma)} brightness, ${pct(DRIFT.sharp)} sharpness, ${pct(DRIFT.grain)} grain, ${pct(DRIFT.face)} face, ${pct(DRIFT.pace)} pace, a colour shift of ${DRIFT.colour}. Hover a row for what it means.`
    : "Measured on this take's own frames when it was rendered. Hover a row for what it means.";
  // In the column at its usual width or narrower (and inside the form's Takes card, narrower still), three figures beside
  // the label did not fit: the second comparison, against the run's start, steps aside. The chart under the table draws
  // the same thing (each clip against the run's start), and the warning in the head still names it.
  const twoVs = cols.length === 2;
  const grid = cols.length === 0 ? "grid-cols-[88px_minmax(0,1fr)]" : cols.length === 1 ? "grid-cols-[88px_repeat(2,minmax(0,1fr))]" : "grid-cols-[88px_repeat(3,minmax(0,1fr))] @max-[24rem]/column:grid-cols-[88px_repeat(2,minmax(0,1fr))]";
  const aside = (i: number) => twoVs && i === 1 && "@max-[24rem]/column:hidden";
  const line = (r: Row) => (
    <div key={r.label} data-tip={r.why} className="contents">
      <span className="truncate py-1 text-ink-2">{r.label}</span>
      <span className={cx("truncate py-1 text-right font-mono tabular-nums", r.bad ? "text-warn" : "text-ink")}>{r.value}</span>
      {r.vs.map((c, i) => <span key={i} className={cx("truncate py-1 text-right font-mono tabular-nums", c.text == null ? "text-ink-3" : c.bad ? "text-warn" : "text-ink-2", aside(i))}>{c.text ?? "—"}</span>)}
    </div>
  );
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-line">
      {/* the warnings go under the title when the column is too narrow for them beside it */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line px-3 py-2">
        <span className="min-w-0 truncate text-[11px] font-bold tracking-[.08em] text-ink-3 uppercase">Look · take {n} of clip {index + 1}</span>
        <Help title="Look" text={note} />
        <span className="grow" />
        {/* at most the head's width, the words cut short there: the full warning is its tip */}
        {warning && <Chip tone="warn" className="max-w-full font-mono" tip={warning}><span className="min-w-0 truncate">{warning}</span></Chip>}
        {m.handover != null && m.handover > DRIFT.handover && <Chip tone="warn" className="font-mono" tip="The model stepped away from its guide where the run-up ends: the join shows. Render a new take.">run-up end ×{m.handover.toFixed(1)}</Chip>}
        </div>
      <div className="px-3 pt-1.5 pb-1 text-xs">
        <div className={cx("grid items-center gap-x-2.5", grid)}>
          <span className="border-b border-line pb-1" />
          <span className="border-b border-line pb-1 text-right text-[11px] font-semibold text-ink-3">this take</span>
          {cols.map((c, i) => <span key={c.head} data-tip={c.tip} className={cx("truncate border-b border-line pb-1 text-right text-[11px] font-semibold text-ink-3", aside(i))}>{c.head}</span>)}
          {rows.map(line)}
          {open && more.map(line)}
        </div>
        {more.length > 0 && (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-1 flex w-full items-center gap-1 border-t border-line py-1.5 text-left text-xs text-ink-3 hover:text-ink">
            <ChevronDown size={13} className={cx("shrink-0 transition-transform", open && "rotate-180")} />
            <span className="truncate">{open ? "Fewer figures" : more.map((r) => r.label).join(", ")}</span>
          </button>
        )}
      </div>
      <RunChart clips={clips} index={index} onSelectClip={onSelectClip} />
    </div>
  );
}

/** The chart's drawing box: as wide as the card, scaled with it; any number of clips fits the same width. */
const CHART = { w: 440, h: 76, left: 10, right: 430, top: 6, bottom: 54, ticks: 70 } as const;

/**
 * The run at a glance: sharpness (accent) and brightness (blue) over every clip of the run, each against the
 * run's start (dashed), this clip marked. Hover a clip for its figures, click to go to it.
 */
function RunChart({ clips, index, onSelectClip }: { clips: Clip[]; index: number; onSelectClip?(id: string): void }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = runSeries(clips, index);
  if (points.length < 2) return null;
  const start = points[0]!.index;
  const values = points.flatMap((p) => [p.sharp, p.luma, p.grain]).filter((v): v is number => v != null);
  const grained = points.some((p) => p.grain != null);
  // a run that barely moves stays flat: at least ±5 % of the height around the middle
  let lo = Math.min(1, ...values);
  let hi = Math.max(1, ...values);
  if (hi - lo < 0.1) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.05;
    hi = mid + 0.05;
  }
  const step = (CHART.right - CHART.left) / (points.length - 1);
  const xAt = (i: number) => CHART.left + i * step;
  const yAt = (v: number) => CHART.top + ((hi - v) / (hi - lo)) * (CHART.bottom - CHART.top);
  // a line through the measured clips; a clip not measured breaks it
  const path = (pick: (p: RunPoint) => number | null) => {
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      const v = pick(p);
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const at = index - start;
  const here = points[at]!;
  const band = Math.max(6, Math.min(16, step * 0.7));
  const tipOf = (p: RunPoint) => {
    const mm = clips[p.index]?.take?.measure;
    if (!mm) return `clip ${p.index + 1} · not measured`;
    const by = (r: number | null) => (r == null || p.index === start ? "" : ` (${pct(r - 1)})`);
    return `clip ${p.index + 1} · sharpness ${sharpOf(mm).toFixed(2)}${by(p.sharp)}${mm.grain != null ? ` · grain ${mm.grain.toFixed(2)}${by(p.grain)}` : ""} · brightness ${mm.luma.toFixed(0)}${by(p.luma)}`;
  };
  const anchor = (i: number) => (points.length > 2 && i === 0 ? "start" : points.length > 2 && i === points.length - 1 ? "end" : "middle");
  return (
    <div className="flex flex-col gap-1.5 border-t border-line bg-raised/50 px-3 pt-2.5 pb-2">
      {/* the legend goes under the title when they do not fit on one line */}
      <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-ink-3">
        <span className="grow">Along the run · {points.length} clips</span>
        <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded-full bg-accent" />sharpness</span>
        <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded-full bg-picture" />brightness</span>
        {grained && <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded-full bg-warn" />grain</span>}
      </span>
      <svg viewBox={`0 0 ${CHART.w} ${CHART.h}`} className="block w-full" role="img" aria-label={`Sharpness and brightness along the ${points.length} clips of this run, against clip ${start + 1}`} onPointerLeave={() => setHover(null)}>
        <line x1={CHART.left} x2={CHART.right} y1={yAt(1)} y2={yAt(1)} stroke="var(--color-line-strong)" strokeDasharray="3 3" />
        <rect x={xAt(at) - band / 2} y={2} width={band} height={CHART.bottom} rx={4} fill="var(--color-accent)" fillOpacity={0.12} />
        {hover !== null && hover !== at && <rect x={xAt(hover) - band / 2} y={2} width={band} height={CHART.bottom} rx={4} fill="var(--color-ink)" fillOpacity={0.07} />}
        <path d={path((p) => p.luma)} fill="none" stroke="var(--color-picture)" strokeWidth={1.6} strokeOpacity={0.85} strokeLinejoin="round" strokeLinecap="round" />
        <path d={path((p) => p.sharp)} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {grained && <path d={path((p) => p.grain)} fill="none" stroke="var(--color-warn)" strokeWidth={1.6} strokeOpacity={0.9} strokeDasharray="4 2" strokeLinejoin="round" strokeLinecap="round" />}
        {here.luma != null && <circle cx={xAt(at)} cy={yAt(here.luma)} r={3.5} fill="var(--color-picture)" stroke="var(--color-panel)" strokeWidth={2} />}
        {here.sharp != null && <circle cx={xAt(at)} cy={yAt(here.sharp)} r={4} fill="var(--color-accent)" stroke="var(--color-panel)" strokeWidth={2} />}
        {runTicks(points.length, at, start + 1).map((i) => (
          <text key={i} x={xAt(i)} y={CHART.ticks} fontSize={9.5} textAnchor={anchor(i)} className="font-mono" fill={i === at ? "var(--color-accent)" : "var(--color-ink-3)"}>{points[i]!.index + 1}</text>
        ))}
        {/* one hit area per clip, as wide as its step: a clip of a run of 60 is still easy to hover */}
        {points.map((p, i) => (
          <rect
            key={p.index}
            x={xAt(i) - step / 2}
            y={0}
            width={step}
            height={CHART.h}
            fill="transparent"
            data-tip={tipOf(p)}
            className={onSelectClip && i !== at ? "cursor-pointer" : undefined}
            onPointerEnter={() => setHover(i)}
            onClick={() => {
              if (onSelectClip && i !== at) onSelectClip(clips[p.index]!.id);
            }}
          />
        ))}
      </svg>
      <span className="text-[11px] text-ink-3">dashed: clip {start + 1} · hover a clip for its figures{onSelectClip ? " · click to go to it" : ""}</span>
    </div>
  );
}
