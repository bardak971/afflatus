import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2, Scissors, TriangleAlert } from "lucide-react";
import { cutAtJoinFigure, cutAtJoinSaid, cutsAtJoin, joinWay, modelsDiffer, newTransition, RUN_UP_CUT, TRANSITION_KINDS, TRANSITION_MS, TRANSITIONS, transitionSpan, type Transition, type TransitionKind } from "@afflatus/core";
import type { Clip, ClipPatch, RecipeInfo, Take } from "../../api";
import { useRecipes } from "../../data";
import { queryKeys } from "../../queryKeys";
import { Button, cx, Help, SectionTitle, Segmented } from "../../ui";
import { FoldButton, useColumnWidth, ColumnEdge } from "../column";
import { JOIN_HELP } from "../attention";
import { joinsOf as askJoins } from "../measures";
import { canExtend } from "../model";
import { SWATCH } from "../transitionLook";
import { CloseButton, Slide } from "./parts";

/** What the "two models" warning's ? says. */
const TWO_MODELS =
  "Each model has its own look. Within one model an extended clip keeps it; across two (here {a} and {b}) the motion carries on from the frames before, but the face, skin and sharpness can shift over a few frames. A hard cut with a short transition hides it best.";

const RUN_UP_TIP = (before: number, n: number) =>
  `How much the picture jumps where the run-up (clip ${before}'s own frames, decoded with clip ${n}) ends and clip ${n}'s own frames begin, against its motion right after. ×1 carries on; past ×${RUN_UP_CUT} the model stepped away from clip ${before}.`;

/** How a transition sits on the clock, said under its choice. */
const timing = (t: Transition) =>
  TRANSITIONS[t.kind].through === "colour"
    ? "Centred on the cut, through a colour: every clip plays where it is, the sound stays in step."
    : "Centred on the cut: the clip before is held on its last frame for the second half, the clip after on its first frame for the first half. No clip moves.";

/** A take made carrying on from the clip before (its first frames that clip's motion), not one made as a hard cut. */
const carriedOn = (t: Take | null) => Boolean(t?.joinKind && t.joinKind !== "still");

/**
 * The join before a clip, opened from its circle on the track: Seamless or Hard cut as two cards, each saying before the
 * click what it does to the take that plays (timelineModel's plays(): a take always plays from after its run-up, so a hard
 * cut keeps it and plays it from its own first frame, no render, and back to seamless it carries on as it was made); how a
 * seamless join holds, or the cut the model made after its run-up (card #161) with its two ways out; a hard cut's transition
 * (its kind, length and sound); and the warning when an extension crosses two video models (allowed, said).
 */
export function JoinPanel({ clip, index, before, recipes, onPatch, retake, onClose, onSelectClip }: {
  clip: Clip;
  index: number;
  before: Clip;
  recipes: RecipeInfo[];
  onPatch(patch: ClipPatch): void;
  /** Render a new take of this clip, carrying on from the take before; `why` it cannot be now (its form, ComfyUI), else null. */
  retake?: { run(): void; why: string | null };
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
  const take = clip.take;
  const takeNo = take ? clip.takes.findIndex((x) => x.id === take.id) + 1 : 0;
  const cuts = extends_ && clip.join === "fresh" && cutsAtJoin(take);
  const holds = extends_ && clip.join === "fresh" && !cuts;
  // the join as it plays, measured as the Overview's chip (one request for the timeline's joins, the same cache)
  const figures = useQuery({
    queryKey: queryKeys.joins.ofTake(clip.id, take?.id ?? "-", take?.startMs ?? 0, take?.endMs ?? 0),
    queryFn: () => askJoins(clip.id).then((items) => ({ items })),
    staleTime: 60_000,
    enabled: extends_ && clip.join === "fresh" && Boolean(take),
  });
  const jump = figures.data?.items.find((j) => j.take === take?.id)?.in ?? null;
  const handover = take?.measure?.handover ?? null;

  // what each card says it does to this join's take, before the click
  const seamlessSays = !take
    ? clip.joined === "continue" ? "not rendered yet" : `clip ${n} will carry on from clip ${index}`
    : clip.joined === "continue"
      ? clip.join === "stale" ? `clip ${index} changed since: a new take` : cuts ? `cut at the join · ${cutAtJoinFigure(take.measure!)}` : clip.join === "fresh" ? `take ${takeNo} holds${jump !== null ? ` · join ×${jump.toFixed(1)}` : ""}` : `clip ${index} has nothing to carry on from yet`
      : clip.joinIfSeamless === "fresh" ? "back to seamless: no render" : clip.joinIfSeamless === "stale" ? "back to seamless: a new take" : `clip ${index} has nothing to carry on from yet`;
  const seamlessTone = clip.joined === "continue" && (cuts || clip.join === "stale") ? "bad" : holds ? "ok" : "";
  const cutSays = !take ? `clip ${n} starts from its own first frame` : clip.joined === "continue" ? `take ${takeNo} kept · plays from its own first frame` : `take ${takeNo} plays from its own first frame`;
  const cutTip = take && clip.joined === "continue"
    ? `Take ${takeNo} stays. It plays from its own first frame${take.headMs > 0 ? ", after the run-up," : ""} as a plain cut: no render.${carriedOn(take) ? ` Its first frames still carry clip ${index}'s motion on.` : ""}${clip.join === "fresh" ? " Back to seamless: as it was, no render." : ""}`
    : undefined;
  const seamlessTip = take && clip.joined === "cut"
    ? clip.joinIfSeamless === "fresh"
      ? `Take ${takeNo} was made carrying on from clip ${index}'s take that plays: seamless again, it plays as it was made, no render.`
      : clip.joinIfSeamless === "stale"
        ? carriedOn(take) ? `Take ${takeNo} was made from another take of clip ${index}, or clip ${index} changed since: seamless needs a new take of clip ${n}.` : `Take ${takeNo} was made as a hard cut: seamless needs a new take of clip ${n}, carrying on from clip ${index}.`
        : undefined
    : undefined;

  // a cut found within a second after the run-up: kept as a hard cut, the take plays from that new shot (trimmed to it, no render)
  const cutAt = cuts ? (take!.measure!.runUpCut?.atMs ?? 0) : 0;
  const keepAsCut = () => onPatch({ joined: "cut", ...(cutAt > 0 ? { trimStartMs: take!.trimStartMs + cutAt } : {}) });
  const way = joinWay(recipeOf(before), recipeOf(clip));

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
          <div role="radiogroup" aria-label="How the clips meet" className="grid grid-cols-2 gap-2">
            <ModeCard
              on={extends_}
              tone={cuts ? "attention" : "accent"}
              icon={<Link2 size={13} />}
              title="Seamless"
              says={`extends clip ${index}: its motion carries on`}
              state={seamlessSays}
              stateTone={seamlessTone}
              tip={seamlessTip}
              onClick={() => onPatch({ joined: "continue" })}
            />
            <ModeCard on={!extends_} tone="accent" icon={<Scissors size={13} />} title="Hard cut" says={`clip ${n} starts on its own`} state={cutSays} tip={cutTip} onClick={() => onPatch({ joined: "cut" })} />
          </div>
        ) : (
          <span className="text-xs text-ink-2">A hard cut: {clip.kind === "still" ? "a still" : recipeOf(clip) ? "this model" : "an imported video"} cannot extend a clip.</span>
        )}

        {holds && take && (jump !== null || handover !== null) && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-raised px-3 py-2.5">
            <span className="text-xs font-semibold">How it holds</span>
            <Figures n={n} before={index} jump={jump} handover={handover} />
          </div>
        )}

        {cuts && take && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-attention/40 bg-attention-wash px-3 py-2.5">
            <span className="flex items-center gap-1.5 font-semibold text-attention-ink">
              <TriangleAlert size={14} /> Cut at the join
              <Help title="Cut at the join" text={`Seamless, but ${cutAtJoinSaid(take.measure!)}.`} />
            </span>
            <span className="text-xs text-ink-2">
              {take.measure!.runUpCut
                ? `Take ${takeNo} cuts to another shot ${take.measure!.runUpCut.atMs ? `${(take.measure!.runUpCut.atMs / 1000).toFixed(2)} s after its run-up` : "right after its run-up"}.`
                : `Take ${takeNo} jumps ×${(take.measure!.handover ?? 0).toFixed(1)} where its run-up ends.`}{" "}
              The model left clip {index} there; most new takes carry on.
            </span>
            <Figures n={n} before={index} jump={jump} handover={handover} cut={take.measure!.runUpCut ? cutAtJoinFigure(take.measure!) : null} />
            <span className="mt-0.5 flex flex-wrap gap-1.5">
              {retake && <Button size="sm" tone="primary" disabled={Boolean(retake.why)} data-tip={retake.why ?? `Render a new take of clip ${n}, carrying on from the same take of clip ${index}: the model makes it anew, and most takes carry on`} onClick={retake.run}>New take</Button>}
              <Button size="sm" data-tip={cutAt > 0 ? `A hard cut onto take ${takeNo}'s new shot: its first ${(cutAt / 1000).toFixed(2)} s trimmed off, no render` : `A hard cut: take ${takeNo} plays from its new shot, no render`} onClick={keepAsCut}>Keep it as a hard cut</Button>
            </span>
          </div>
        )}

        {extends_ && !take && (
          <div className="flex flex-col gap-1 rounded-lg border border-dashed border-accent/50 px-3 py-2.5">
            <span className="font-semibold text-accent">Not rendered yet</span>
            <span className="text-xs text-ink-2">
              {way === "seamless" ? `Clip ${n} will carry on from clip ${index}'s last frames, decoded with them.` : `Clip ${n} will carry on from clip ${index}'s last frames.`}
            </span>
          </div>
        )}

        {extends_ && clip.join === "stale" && (
          <div className="flex flex-col gap-2 rounded-lg border border-attention/40 bg-attention-wash p-3">
            <span className="font-semibold text-attention-ink">Clip {n} no longer follows clip {index}</span>
            <span className="text-xs text-ink-2">
              {carriedOn(take) ? `Clip ${index} changed after this one was made from it.` : `Take ${takeNo} was made as a hard cut.`} Render clip {n} again (in its panel), or keep the join as a hard cut.
            </span>
            <span className="flex gap-1.5">
              <Button size="sm" onClick={() => onSelectClip(clip.id)}>Open clip {n}</Button>
              <Button size="sm" onClick={() => onPatch({ joined: "cut" })}>Keep as a hard cut</Button>
            </span>
          </div>
        )}

        {!extends_ && extendable && take && carriedOn(take) && (
          <span className="border-l-2 border-line-strong py-0.5 pl-2.5 text-xs text-ink-2">
            Take {takeNo} was made seamless: it plays from its own first frame, as a hard cut. A new take of clip {n} starts on its own, from its form.
          </span>
        )}

        {differ && (
          <div className="flex flex-col gap-2 rounded-lg border border-attention/40 bg-attention-wash p-3">
            <span className="flex items-center gap-1.5 font-semibold text-attention-ink">
              <TriangleAlert size={14} /> Two models: the face may change here
              <Help title="Two models" text={TWO_MODELS.replace("{a}", nameOf(before)).replace("{b}", nameOf(clip))} />
            </span>
            <span className="text-xs text-ink-2">The motion carries on from clip {index}'s last frames, but {nameOf(clip)} draws the person its own way.</span>
            <Button size="sm" className="self-start" onClick={() => set(newTransition("flash"))}><Scissors size={13} /> Make it a hard cut with a Flash</Button>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5">
            <SectionTitle>Transition</SectionTitle>
            <Help title="Transitions" text="On a hard cut only: a seamless join carries on from the frames before, there is nothing to blend. Or drag one from the strip under the track onto a join (it makes the join a hard cut)." />
            {extends_ && (
              <>
                <span className="text-xs text-ink-2">· needs a hard cut</span>
                <button type="button" className="ml-auto text-xs text-ink-2 underline decoration-line-strong underline-offset-3 hover:text-ink" onClick={() => onPatch({ joined: "cut" })}>Make it a hard cut</button>
              </>
            )}
          </span>
          <div className={cx("grid grid-cols-3 gap-1.5 @[360px]/column:grid-cols-4", extends_ && "pointer-events-none opacity-40")} aria-disabled={extends_}>
            <KindCell label="None" swatch="linear-gradient(90deg, #b06a3c 50%, #4a76a8 50%)" on={!t && !extends_} onClick={() => set(null)} />
            {TRANSITION_KINDS.map((k) => (
              <KindCell key={k} label={TRANSITIONS[k].label} swatch={SWATCH[k]} on={t?.kind === k && !extends_} onClick={() => set(t ? { ...t, kind: k, ms: TRANSITIONS[k].ms } : newTransition(k))} />
            ))}
          </div>
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

/** One of the join's two modes: what it is, and what it does (or would do) to this join's take, said on the card itself. */
function ModeCard({ on, tone, icon, title, says, state, stateTone = "", tip, onClick }: {
  on: boolean;
  tone: "accent" | "attention";
  icon: ReactNode;
  title: string;
  says: string;
  state: string;
  stateTone?: "ok" | "bad" | "";
  tip?: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      data-tip={on ? undefined : tip}
      data-tip-head={on || !tip ? undefined : title}
      onClick={on ? undefined : onClick}
      className={cx(
        "flex min-w-0 flex-col gap-1 rounded-control border p-2.5 text-left",
        on ? (tone === "attention" ? "border-attention bg-attention-wash" : "border-accent bg-accent-wash") : "border-line bg-raised hover:border-line-strong hover:bg-hover",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-semibold">{icon} {title}</span>
      <span className="text-xs text-ink-2">{says}</span>
      <span className={cx("mt-0.5 font-mono text-xs", stateTone === "ok" ? "text-good" : stateTone === "bad" ? "text-attention-ink" : "text-ink-3")}>{state}</span>
    </button>
  );
}

/** The join's figures with their units: the jump across it (the Overview's), and where its run-up ends (Look's). */
function Figures({ n, before, jump, handover, cut }: { n: number; before: number; jump: number | null; handover: number | null; cut?: string | null }) {
  const row = (label: string, tip: string, unit: string, value: string, bad: boolean) => (
    <>
      <span className="flex items-center gap-1.5 text-ink-2">{label}<Help title={label} text={tip} /></span>
      <span className="truncate text-xs text-ink-3">{unit}</span>
      <span className={cx("text-right font-mono", bad ? "text-attention-ink" : "text-good")}>{value}</span>
    </>
  );
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 text-sm">
      {jump !== null && row("Join", JOIN_HELP, "jump ÷ the clip's own motion", `×${jump.toFixed(1)}`, jump > RUN_UP_CUT)}
      {handover !== null && row("Run-up end", RUN_UP_TIP(before, n), cut ? `then a cut, ${cut}` : handover > RUN_UP_CUT ? "the model stepped away" : "carries on", `×${handover.toFixed(1)}`, Boolean(cut) || handover > RUN_UP_CUT)}
    </div>
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
