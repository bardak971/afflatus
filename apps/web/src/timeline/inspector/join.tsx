import { Scissors, TriangleAlert } from "lucide-react";
import { modelsDiffer, newTransition, TRANSITION_KINDS, TRANSITION_MS, TRANSITIONS, transitionSpan, type Transition, type TransitionKind } from "@afflatus/core";
import type { Clip, ClipPatch, RecipeInfo } from "../../api";
import { useRecipes } from "../../data";
import { Button, cx, Help, SectionTitle, Segmented } from "../../ui";
import { FoldButton, useColumnWidth, ColumnEdge } from "../column";
import { canExtend } from "../model";
import { SWATCH } from "../transitionLook";
import { CloseButton, Slide } from "./parts";

/** What the "two models" warning's ? says. */
const TWO_MODELS =
  "Each model has its own look. Within one model an extended clip keeps it; across two (here {a} and {b}) the motion carries on from the frames before, but the face, skin and sharpness can shift over a few frames. A cut with a short transition hides it best.";

/** How a transition sits on the clock, said under its choice. */
const timing = (t: Transition) =>
  TRANSITIONS[t.kind].through === "colour"
    ? "Centred on the cut, through a colour: every clip plays where it is, the sound stays in step."
    : "Centred on the cut: the clip before is held on its last frame for the second half, the clip after on its first frame for the first half. No clip moves.";

/**
 * The join before a clip, opened from its dot on the track: extend or cut, a cut's transition (its kind, length and
 * sound), and the warning when an extension crosses two video models (allowed, said).
 */
export function JoinPanel({ clip, index, before, recipes, onPatch, onClose, onSelectClip }: {
  clip: Clip;
  index: number;
  before: Clip;
  recipes: RecipeInfo[];
  onPatch(patch: ClipPatch): void;
  onClose(): void;
  onSelectClip(id: string): void;
}) {
  const panelWidth = useColumnWidth();
  const all = useRecipes().data;
  const recipeOf = (c: Clip) => recipes.find((r) => r.id === c.recipe) ?? all?.recipes.find((r) => r.id === c.recipe);
  const nameOf = (c: Clip) => {
    if (c.kind === "still") return "Still";
    const r = recipeOf(c);
    return r ? (all?.families.find((f) => f.id === r.family)?.name ?? r.title) : "Imported video";
  };
  const extendable = canExtend(clip, before, recipeOf(clip));
  const extends_ = clip.joined === "continue" && extendable;
  const differ = extends_ && modelsDiffer(recipeOf(before), recipeOf(clip));
  const t = clip.transition;
  const span = transitionSpan(t, "cut", before.lengthMs, clip.lengthMs);
  const set = (next: Transition | null) => onPatch({ transition: next });
  const n = index + 1;
  return (
    <aside data-designer-stays style={{ width: panelWidth }} className="relative flex shrink-0 flex-col border-l border-line bg-panel">
      <ColumnEdge />
      <div className="flex shrink-0 items-start gap-2 border-b border-line px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 grow flex-wrap items-center gap-1.5 pt-0.5">
          <span className="mr-0.5 flex h-6 shrink-0 items-center rounded-chip bg-accent-wash px-2 text-xs font-bold text-accent uppercase">Join</span>
          <button type="button" onClick={() => onSelectClip(before.id)} className="font-semibold hover:underline" data-tip={`Open clip ${index}`}>clip {index}</button>
          <span className="text-ink-3">→</span>
          <button type="button" onClick={() => onSelectClip(clip.id)} className="font-semibold hover:underline" data-tip={`Open clip ${n}`}>clip {n}</button>
        </div>
        <FoldButton />
        <span className="ml-1.5 flex shrink-0 border-l border-line pl-1.5"><CloseButton onClose={onClose} /></span>
      </div>

      <div className="flex min-h-0 grow flex-col gap-4 overflow-y-auto p-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="truncate font-semibold">{nameOf(before)}</span>
          <span className="shrink-0 text-ink-3">→</span>
          <span className="truncate font-semibold">{nameOf(clip)}</span>
        </div>

        {extendable ? (
          <Segmented<"continue" | "cut">
            label="How the clips meet"
            value={clip.joined}
            onChange={(joined) => onPatch({ joined })}
            options={[{ value: "continue", label: `Extend clip ${index}`, tip: "Its motion carries on from the end of the clip before" }, { value: "cut", label: "Cut" }]}
          />
        ) : (
          <span className="text-xs text-ink-2">A cut: {clip.kind === "still" ? "a still" : recipeOf(clip) ? "this model" : "an imported video"} cannot extend a clip.</span>
        )}

        {extends_ && clip.join === "stale" && (
          <div className="flex flex-col gap-2 rounded-lg border border-attention/40 bg-attention-wash p-3">
            <span className="font-semibold text-attention-ink">Clip {n} no longer follows clip {index}</span>
            <span className="text-xs text-ink-2">Clip {index} changed after this one was made from it. Render clip {n} again (in its panel), or keep the join as a cut.</span>
            <span className="flex gap-1.5">
              <Button size="sm" onClick={() => onSelectClip(clip.id)}>Open clip {n}</Button>
              <Button size="sm" onClick={() => onPatch({ joined: "cut" })}>Keep as a cut</Button>
            </span>
          </div>
        )}

        {differ && (
          <div className="flex flex-col gap-2 rounded-lg border border-attention/40 bg-attention-wash p-3">
            <span className="flex items-center gap-1.5 font-semibold text-attention-ink">
              <TriangleAlert size={14} /> Two models: the face may change here
              <Help title="Two models" text={TWO_MODELS.replace("{a}", nameOf(before)).replace("{b}", nameOf(clip))} />
            </span>
            <span className="text-xs text-ink-2">The motion carries on from clip {index}'s last frames, but {nameOf(clip)} draws the person its own way.</span>
            <Button size="sm" className="self-start" onClick={() => set(newTransition("flash"))}><Scissors size={13} /> Make it a cut with a Flash</Button>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5">
            <SectionTitle>Transition</SectionTitle>
            <Help title="Transitions" text="On a cut only: an extended clip carries on from the frames before, there is nothing to blend. Or drag one from the strip under the track onto a join." />
          </span>
          <div className={cx("grid grid-cols-3 gap-1.5 @[360px]/column:grid-cols-4", extends_ && "pointer-events-none opacity-40")} aria-disabled={extends_}>
            <KindCell label="Cut" swatch="linear-gradient(90deg, #b06a3c 50%, #4a76a8 50%)" on={!t} onClick={() => set(null)} />
            {TRANSITION_KINDS.map((k) => (
              <KindCell key={k} label={TRANSITIONS[k].label} swatch={SWATCH[k]} on={t?.kind === k} onClick={() => set(t ? { ...t, kind: k, ms: TRANSITIONS[k].ms } : newTransition(k))} />
            ))}
          </div>
          {extends_ && <span className="text-xs text-ink-2">On a cut only: it extends clip {index}.</span>}
        </div>

        {t && !extends_ && (
          <>
            <Slide label="Length" value={t.ms} min={TRANSITION_MS.least} max={TRANSITION_MS.most} step={10} show={(ms) => `${(ms / 1000).toFixed(2)} s · ${Math.round((ms * 24) / 1000)} fr`} onCommit={(ms) => set({ ...t, ms })} />
            {span > 0 && span < t.ms && <span className="text-xs text-warn-ink">Plays {(span / 1000).toFixed(2)} s: half of it must fit in each clip.</span>}
            {span === 0 && <span className="text-xs text-warn-ink">Not played: a clip here is too short for it.</span>}
            <div className="flex items-center gap-2.5">
              <span className="grow font-semibold">Audio</span>
              <Segmented<"on" | "fade"> label="Audio over the transition" size="sm" oneLine value={t.sound} onChange={(sound) => set({ ...t, sound })} options={[{ value: "on", label: "Straight on" }, { value: "fade", label: "Fade out and in" }]} />
            </div>
            <span className="text-xs text-ink-2">{timing(t)}</span>
          </>
        )}
      </div>
    </aside>
  );
}

function KindCell({ label, swatch, on, onClick }: { label: string; swatch: string; on: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx("flex flex-col gap-1 rounded-lg border p-1.5 text-left text-meta font-semibold", on ? "border-accent bg-accent-wash" : "border-line bg-raised hover:border-line-strong")}
    >
      <span className="h-6 rounded" style={{ background: swatch }} />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The transition kinds in the strip under the track, dragged onto a join. */
export const STRIP_KINDS: TransitionKind[] = ["dissolve", "dip-black", "dip-white", "flash", "wipe-left", "slide-left", "zoom"];
