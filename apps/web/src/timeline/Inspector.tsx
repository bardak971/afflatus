import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ChevronDown, ChevronLeft, ImagePlus, Music, Trash2, Wand2, X } from "lucide-react";
import { secondsInput } from "@afflatus/core";
import { api, thumbUrl, type Clip, type RecipeInfo, type RunningJob, type Take, type Timeline, type TimelinePatch } from "../api";
import { useEntities, useRecipes, useSetup } from "../data";
import { WritingHelp } from "../WritingHelp";
import { appendTo } from "../promptText";
import { LookBar, lookWords } from "../LookBar";
import { FormModel } from "../ModelLoad";
import { about, aboutMs, clock, phaseLabel, recipeLabel } from "../format";
import { Picker } from "../PictureField";
import { Form, mainTextOf } from "../RecipeForm";
import { CastPictures } from "../castPictures";
import { Select } from "../Select";
import { AutoText, Bar, Button, cx, ErrorNote, Help, Note, NumberBox, PanelEdge, SectionTitle, Segmented, Toggle, TwoStep } from "../ui";
import { usePanelWidth } from "../store";
import { fileVersion, otherShape, pinInputs, roomOf, shapeOf, type ShownPatch } from "./model";
import { DRAG_PICTURE, useDropZone } from "../dragging";
import { projectForNew } from "../project";

/** A slider that says its value while it moves and saves it when it is let go. */
function Slide({ label, value, min = 0, max, step = 1, show, onCommit }: { label: string; value: number; min?: number; max: number; step?: number; show(value: number): string; onCommit(value: number): void }) {
  const [local, setLocal] = useState<number | null>(null);
  const shown = local ?? value;
  const commit = () => {
    if (local !== null && local !== value) onCommit(local);
    setLocal(null);
  };
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between">
        <span>{label}</span>
        <span className="font-mono text-ink-2">{show(shown)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={shown} onChange={(e) => setLocal(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} className="w-full" />
    </label>
  );
}

/** The music's own panel: one sound under the whole video. */
export function MusicPanel({ timeline, onEdit }: { timeline: Timeline; onEdit(patch: TimelinePatch): void }) {
  const m = timeline.music;
  const [picking, setPicking] = useState(false);
  if (!m) return null;
  return (
    <aside style={{ width: usePanelWidth.getState().width }} className="relative flex shrink-0 flex-col border-l border-line bg-panel">
      <PanelEdge side="left" />
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <Music size={15} className="text-accent" />
        <span className="font-semibold">Music</span>
        <span className="min-w-0 truncate text-ink-2">{m.asset.name || "an audio file"}{m.asset.durationMs ? ` · ${clock(m.asset.durationMs)}` : ""}</span>
      </div>
      <div className="flex min-h-0 grow flex-col gap-4 overflow-y-auto p-4">
        <span className="text-ink-2">Plays under the whole video. Drop another audio file on the music track to replace it.</span>
        <Slide label="Volume" value={m.volume} max={100} show={(v) => `${v}%`} onCommit={(volume) => onEdit({ music: { volume } })} />
        <Slide label="Fade in" value={m.fadeInMs} max={10_000} step={500} show={(v) => `${(v / 1000).toFixed(1)} s`} onCommit={(fadeInMs) => onEdit({ music: { fadeInMs } })} />
        <Slide label="Fade out" value={m.fadeOutMs} max={10_000} step={500} show={(v) => `${(v / 1000).toFixed(1)} s`} onCommit={(fadeOutMs) => onEdit({ music: { fadeOutMs } })} />
        <Toggle on={m.duck} onChange={(duck) => onEdit({ music: { duck } })} label="Duck under speech" note="the music dips where people speak in the clips, in the player and the export alike" />
        {m.duck && <Slide label="Duck by" value={m.duckDb} min={3} max={30} step={1} show={(v) => `−${v} dB`} onCommit={(duckDb) => onEdit({ music: { duckDb } })} />}
        {m.asset.durationMs && m.asset.durationMs < timeline.durationMs ? <span className="text-xs text-ink-2">It is shorter than the video: it stops at {clock(m.asset.durationMs)}.</span> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setPicking(true)}>Choose another audio file</Button>
          <Button size="sm" onClick={() => onEdit({ music: { asset: null } })}><Trash2 size={13} /> Remove music</Button>
        </div>
      </div>
      {picking && <Picker title="Music" kind="audio" onClose={() => setPicking(false)} onPick={(asset) => { onEdit({ music: { asset } }); setPicking(false); }} />}
    </aside>
  );
}

/** The selected clip: how it starts, its takes, its sound, its pictures and its form. */
/** Where how many takes a render makes is remembered, per browser. */
const TAKES_KEY = "afflatus.timeline.takes";

export function Inspector({ timeline, clip, index, recipes, stored, whole, why, takesMs, running, busy, error, onInputs, onRecipe, onPatch, onRender, onRemove, onRemoveTake, onStop, onPreview, onDesigner, writing, writeError, onWriteBetween, onClose }: {
  timeline: Timeline;
  clip: Clip;
  index: number;
  recipes: RecipeInfo[];
  /** The clip's form: what was touched. */
  stored: Record<string, unknown>;
  /** The clip's whole form as a render would send it, written or not: what its models are told from. */
  whole: Record<string, unknown> | null;
  /** Why it cannot be rendered right now, in a sentence. */
  why: string | null;
  /** About how long a render of it takes, in ms; null when nothing like it was rendered yet. */
  takesMs: number | null;
  running: RunningJob | null;
  busy: boolean;
  error: string | null;
  onInputs(next: Record<string, unknown>): void;
  onRecipe(id: string): void;
  onPatch(patch: ShownPatch): void;
  /** Render it: `count` takes at once (the first with the form's seed, the others with a fresh one each). */
  onRender(fit: boolean, count: number): void;
  onRemove(): void;
  onRemoveTake(id: string): void;
  /** Stop the render of this clip that is under way, or take it out of the queue. */
  onStop(): void;
  /** Make the clip end where it begins: on its opening picture, or on the first frame of its take. */
  /** A take is hovered: show it in the player without choosing it. */
  onPreview(take: Take | null): void;
  /** Open the designer for this clip. */
  onDesigner(): void;
  /** The designer is writing what happens between the clips around (a clip put between two others). */
  writing?: boolean;
  writeError?: string | null;
  /** Ask the designer to write it (again). */
  onWriteBetween?(): void;
  /** Back to the timeline's own panel (its name, music, cast, where renders land, export): also Escape. */
  onClose?(): void;
}) {
  const panelWidth = usePanelWidth((st) => st.width);
  const all = useRecipes();
  const setup = useSetup();
  const entities = useEntities();
  const [fit, setFit] = useState(true);
  // how many takes a render makes at once, remembered per browser
  const [count, setCount] = useState<1 | 2 | 3>(() => {
    try {
      const n = Number(localStorage.getItem(TAKES_KEY));
      return n === 2 || n === 3 ? n : 1;
    } catch {
      return 1;
    }
  });
  const pickCount = (n: 1 | 2 | 3) => {
    setCount(n);
    try {
      localStorage.setItem(TAKES_KEY, String(n));
    } catch {
      // the choice is not kept, nothing more
    }
  };
  const takes = aboutMs(takesMs === null ? null : takesMs * count);
  const [picking, setPicking] = useState<"sound" | "start" | "end" | "mid" | null>(null);
  const recipe = recipes.find((r) => r.id === clip.recipe) ?? all.data?.recipes.find((r) => r.id === clip.recipe);
  const status = setup.data?.recipes.find((r) => r.id === recipe?.id);
  const before = index > 0 ? timeline.clips[index - 1] : undefined;
  const after = timeline.clips[index + 1];
  const still = clip.kind === "still";
  const carries = Boolean(before) && clip.joined === "continue" && !still;
  const canCarry = Boolean(recipe?.traits?.continues) || (before?.kind === "still" && Boolean(pinInputs(recipe).start));
  const pins = pinInputs(recipe);
  const opens = !carries && pins.start && typeof stored[pins.start] === "string" ? (stored[pins.start] as string) : null;
  const ends = pins.end && typeof stored[pins.end] === "string" ? (stored[pins.end] as string) : null;
  const through = pins.mid && typeof stored[pins.mid] === "string" ? (stored[pins.mid] as string) : null;
  const midSpec = recipe?.inputs.find((i) => i.id === pins.midAt);
  // what the timeline fills in itself is not asked for in the form: the clips it joins onto, and its pinned pictures (shown above it)
  const form = useMemo(
    () => (recipe ? { ...recipe, inputs: recipe.inputs.filter((i) => i.type !== "clip" && !(i.type === "image" && (i.role === "start" || i.role === "end" || i.role === "mid")) && i.id !== pins.midAt) } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recipe],
  );
  const canFit = Boolean(recipe?.traits?.endAnchor && after?.take && after.joined === "continue");
  const take = clip.take;
  const loops = Boolean(ends && (ends === opens));
  /** How much of the take can play at most: its video on the model's grid without the parts it shares with its neighbours (the server's). */
  const room = take ? roomOf(take) : 0;
  const shapes = { tall: "portrait", wide: "landscape", square: "square" } as const;
  const shown = still ? clip.still : take?.asset;
  const misfit = otherShape(clip, timeline) && shown?.width && shown.height && timeline.width && timeline.height
    ? `This ${still ? "still" : "clip"} is ${shapes[shapeOf(shown.width, shown.height)]}, the video is ${shapes[shapeOf(timeline.width, timeline.height)]}.`
    : null;
  // a neighbour joined to it at another size (enlarged in its render, or finished, when this one is not): the join shows a change of sharpness
  const sizeStep = (() => {
    const px = (a: { width: number | null; height: number | null } | undefined) => (a?.width && a.height ? a.width * a.height : 0);
    const mine = px(take?.asset);
    if (!mine) return null;
    const odd = [clip.joined === "continue" ? before : undefined, after?.joined === "continue" ? after : undefined]
      .find((n) => n?.take && px(n.take.asset) && Math.max(px(n.take.asset), mine) / Math.min(px(n.take.asset), mine) >= 1.5);
    return odd?.take ? { other: odd.take.asset, before: odd === before } : null;
  })();
  const hasOwn = Boolean(take?.asset.hasSound);
  // how smoothly each take meets the clips around: worked out once there is a choice to make
  const joins = useQuery({
    queryKey: ["joins", clip.id, clip.takes.map((t) => `${t.id}:${t.startMs}:${t.endMs}`).join(","), before?.take?.id ?? before?.still?.id ?? "-", after?.take?.id ?? after?.still?.id ?? "-"],
    queryFn: () => api.joins(clip.id),
    enabled: clip.takes.length > 1 && Boolean(before || after),
    staleTime: Infinity,
  });
  const joinOf = (takeId: string) => joins.data?.items.find((j) => j.take === takeId);
  const worst = (j: { in: number | null; out: number | null } | undefined) => Math.max(j?.in ?? 0, j?.out ?? 0);
  const smoothest = joins.data && clip.takes.length > 1 ? clip.takes.reduce<string | null>((best, t) => (best === null || worst(joinOf(t.id)) < worst(joinOf(best)) ? t.id : best), null) : null;
  const heard = clip.sound === "file" ? "file" : clip.sound === "muted" && hasOwn ? "muted" : "own";


  // ---- what the clip got (its takes, how much of the one that plays is used, how it looks) and its pinned
  // frames: above the form for a clip with no form; inside it otherwise, as its Takes chapter and in Inputs
  const inForm = Boolean(!still && form && recipe);
  const takesInner = clip.takes.length > 0 ? <TakeList clip={clip} take={take} joinOf={joinOf} smoothest={smoothest} onPreview={onPreview} onPatch={onPatch} onRemoveTake={onRemoveTake} /> : null;
  const takesHelp = clip.takes.length > 1 ? `Hover a take to preview it, click to make it play.${joins.data ? " The join figures say how much the picture jumps at In and at Out (×1 = like the clip's own motion); the smoothest is marked." : joins.isFetching ? " Measuring the joins…" : ""}` : "Each render adds a take. The one you pick plays.";
  const durationInner = still || take ? <Duration clip={clip} take={take} room={room} rendered={Boolean(recipe)} onPatch={onPatch} /> : null;
  const lookInner = take?.measure && !still ? <LookTable timeline={timeline} index={index} take={take} /> : null;
  const pinnedInner = recipe && !still && (pins.start || pins.end) ? <PinnedFrames stored={stored} pins={pins} frames={{ opens, ends, through, loops, carries }} midDefault={midSpec?.type === "number" ? midSpec.default : 2.5} onInputs={onInputs} onPick={setPicking} /> : null;
  const pinHelp = `${carries && pins.start ? `It extends clip ${index}, so it needs no first frame. ` : ""}Or drop an image on the clip: near its start for the first frame, near its end for the last frame${pins.mid ? ", in the middle for a keyframe" : ""}.${take ? " A pinned frame counts from the next take." : ""}`;
  const playing = take ? clip.takes.findIndex((t) => t.id === take.id) + 1 : 0;
  const takesLead = inForm && (takesInner || durationInner) ? {
    id: "takes",
    title: "Takes",
    summary: take ? `take ${playing} of ${clip.takes.length} plays · ${(clip.lengthMs / 1000).toFixed(1)} s${take.trimStartMs > 0 || take.trimEndMs > 0 ? " · trimmed" : ""}` : "none yet",
    node: (
      <div className="flex flex-col gap-3">
        {takesInner}
        <span className="flex items-center gap-1.5 text-xs text-ink-2">{clip.takes.length > 1 ? "Hover a take to preview it, click to make it play." : "Each render adds a take; the one you pick plays."}<Help text={takesHelp} /></span>
        {durationInner}
        {lookInner}
      </div>
    ),
  } : undefined;
  const pinWords = [opens && "first frame", through && "keyframe", ends && "last frame"].filter(Boolean).join(", ");
  const framesExtra = inForm && pinnedInner ? {
    summary: pinWords ? `pinned ${pinWords}` : "",
    node: (
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-xs font-semibold">Pinned frames<Help text={pinHelp} /></span>
        {pinnedInner}
      </div>
    ),
  } : undefined;

  return (
    <aside data-designer-stays style={{ width: panelWidth }} className="relative flex shrink-0 flex-col border-l border-line bg-panel">
      <PanelEdge side="left" />
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2 pl-2">
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Back to the timeline" title="Back to the timeline's own panel: its music, cast and export (Esc)" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink">
            <ChevronLeft size={16} />
          </button>
        )}
        <span className="font-semibold">{still ? "Still" : "Clip"} {index + 1}</span>
        <span className="text-ink-2">{clip.lengthMs ? `${(clip.lengthMs / 1000).toFixed(1)} s` : "not rendered yet"}</span>
        <span className="grow" />
        <TwoStep title="Remove from timeline" icon={<Trash2 size={15} />} note={still ? "The image stays in your library." : "Its videos stay in your library."} yes="Remove" onYes={onRemove} className="rounded-lg" />
      </div>

      <div className="flex min-h-0 grow flex-col gap-3.5 overflow-y-auto p-4">
        {still && clip.still && (
          <>
            <img src={thumbUrl(clip.still.id)} alt={clip.still.name} className="max-h-56 self-start rounded-lg" />
            <span className="text-ink-2">A still: an image held on screen.</span>
            <span><Button onClick={() => onPatch({ animate: true })}>Image to video (i2v)</Button></span>
          </>
        )}

        {/* how it joins the clip before is on the track: the dot between them switches cut and extend; only a broken join is said here */}
        {before && !still && clip.join === "stale" && (
          <div className="flex flex-col gap-2 rounded-lg border border-warn bg-warn-wash p-3">
            <span className="font-semibold text-warn-ink">This clip no longer follows clip {index}</span>
            <span className="text-xs text-ink-2">Clip {index} changed after this one was rendered, so {before.kind === "still" ? "its first frame is no longer that image" : "the motion jumps between them"}.</span>
            <span className="flex flex-wrap gap-1.5">
              {recipe && <Button size="sm" tone="danger" disabled={Boolean(why) || busy || Boolean(clip.job)} onClick={() => onRender(fit, count)}>Re-render{takes ? ` · ${takes}` : ""}</Button>}
              <Button size="sm" onClick={() => onPatch({ joined: "cut" })}>Keep as a cut</Button>
            </span>
          </div>
        )}

        {clip.failed && !clip.job && <ErrorNote>The last render failed: {clip.failed}</ErrorNote>}

        {misfit && (
          <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <span>{misfit} {clip.fill ? "It fills the frame: its edges are cropped." : "It is letterboxed: shown whole, with bars."}</span>
            <Toggle on={clip.fill} onChange={(fill) => onPatch({ fill })} label="Fill frame (crop)" />
          </div>
        )}

        {sizeStep && take && (
          <div className="rounded-lg border border-line p-3 text-xs text-ink-2">
            This clip is {take.asset.width} × {take.asset.height}, the clip {sizeStep.before ? "before" : "after"} {sizeStep.other.width} × {sizeStep.other.height}: one was enlarged and the other not, so the join shows a change of sharpness. Finish all clips (the Finish button above the timeline) to bring every clip to one size the same way, or render both alike.
          </div>
        )}

        {!inForm && takesInner && <div className="flex flex-col gap-2"><SectionTitle>Takes</SectionTitle>{takesInner}</div>}
        {!inForm && durationInner && <div className="flex flex-col gap-2"><SectionTitle>Duration</SectionTitle>{durationInner}</div>}
        {!inForm && lookInner}
        {!inForm && pinnedInner && <div className="flex flex-col gap-2"><SectionTitle>Pinned frames</SectionTitle>{pinnedInner}</div>}

        {!still && (
          <>
            {!recipe && take && (
              <div className="rounded-lg bg-raised px-3 py-2.5 text-ink-2">
                An imported video. It can be trimmed, and a new clip can extend from any of its frames. It cannot be re-rendered, unless you choose a model to render in its place:
              </div>
            )}
            {(() => {
              const picker = (
                <Select
                  label="Model"
                  value={recipe?.id ?? ""}
                  onChange={onRecipe}
                  placeholder={recipes.length ? "Choose a model for this clip" : "No video model yet: import a workflow"}
                  options={recipes.map((r) => ({ value: r.id, label: recipeLabel(all.data?.families.find((f) => f.id === r.family)?.name, r.title), detail: r.summary }))}
                />
              );
              // nothing renders it yet: only the choice of what does
              if (!form || !recipe) return <div className="flex flex-col gap-1.5"><div className="text-xs font-semibold">Model</div>{picker}</div>;
              const main = mainTextOf(form);
              const written = main ? String(stored[main.id] ?? "") : "";
              const cast = clip.look === null ? (
                <div className="flex flex-col gap-1.5">
                  <div className="text-xs font-semibold">Cast and places</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{lookWords(timeline.look, entities.data?.items ?? []) || "Nobody yet"}</span>
                    <span className="text-xs text-ink-2">from the timeline</span>
                    <Button size="sm" onClick={() => onPatch({ look: timeline.look ?? { cast: [], style: null } })}>Change for this clip</Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <LookBar title="Cast and places, for this clip only" look={clip.look} onChange={(look) => onPatch({ look })} recipe={recipe} input={stored} />
                  <span><Button size="sm" onClick={() => onPatch({ look: null })}>Use the timeline's again</Button></span>
                </div>
              );
              // a clip that joins its neighbours and is not rendered yet: what matters for the join first, the whole form folded under it
              const nextJoined = Boolean(after && after.joined === "continue" && after.take);
              // the Join view is for a clip put between two others: something to arrive at, not merely a clip that extends the one before
              const joins = !take && (nextJoined || Boolean(ends));
              const leftFrame = opens ? thumbUrl(opens) : carries && before ? (before.kind === "still" && before.still ? thumbUrl(before.still.id) : before.take ? `/api/assets/${before.take.asset.id}/peek?at=${Math.max(0, Math.round(before.take.endMs - 20))}&h=160&v=${fileVersion(before.take.asset)}` : null) : null;
              const rightFrame = ends ? thumbUrl(ends) : nextJoined && after?.take ? `/api/assets/${after.take.asset.id}/peek?at=${Math.round(after.take.startMs)}&h=160&v=${fileVersion(after.take.asset)}` : null;
              const startsHow = carries ? `Extends clip ${index}: its motion carries in` : opens ? `Opens on a picture` : "Starts on its own";
              const endsHow = nextJoined ? `ends where clip ${index + 2} begins` : ends ? "ends on a picture" : "ends free";
              const seconds = secondsInput(form.inputs);
              const landing = recipe.inputs.find((i) => i.id === "landing" && i.type === "choice");
              const landingOptions = landing && landing.type === "choice" && Array.isArray(landing.options) ? landing.options : [];
              const formElement = (
                  <CastPictures recipe={form} input={whole ?? stored} look={clip.look ?? timeline.look}>
                  <Form
                    key={`${clip.id}:${form.id}`}
                    recipe={form}
                    given={carries ? { previous: true } : undefined}
                    status={status}
                    stored={stored}
                    onChange={(input, value) => onInputs({ ...stored, [input]: value })}
                    onClear={(inputs) => onInputs(Object.fromEntries(Object.entries(stored).filter(([k]) => !inputs.includes(k))))}
                    made={picker}
                    madeSummary={recipeLabel(all.data?.families.find((f) => f.id === recipe.family)?.name, recipe.title)}
                    look={cast}
                    lookSummary={lookWords(clip.look ?? timeline.look, entities.data?.items ?? []) + (clip.look === null && timeline.look ? " (from the timeline)" : "")}
                    lead={takesLead}
                    frameExtra={framesExtra}
                    helpers={
                      <WritingHelp
                        recipe={form}
                        text={written}
                        // a clip that follows the timeline's cast gets a look of its own with the first snippet ticked: the timeline's, plus it
                        look={clip.look ?? timeline.look}
                        onLook={(look) => onPatch({ look })}
                        onDesigner={onDesigner}
                        onInsert={(snippet) => main?.type === "prompt" && onInputs({ ...stored, [main.id]: appendTo(written, snippet, main.style) })}
                      />
                    }
                  />
                  </CastPictures>
              );
              if (!joins) return <div className="flex flex-col gap-2.5">{formElement}</div>;
              return (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2.5 rounded-xl border border-accent/40 bg-accent-wash/30 p-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-raised">{leftFrame ? <img src={leftFrame} alt="" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} /> : <span className="text-[10px] text-ink-3">—</span>}</div>
                      <div className="flex min-w-0 grow flex-col gap-0.5 text-xs">
                        <span className="font-semibold">Join</span>
                        <span className="text-ink-2">{startsHow} · {endsHow}.</span>
                      </div>
                      <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-raised">{rightFrame ? <img src={rightFrame} alt="" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} /> : <span className="text-[10px] text-ink-3">—</span>}</div>
                    </div>
                    {main && (
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-semibold">What happens <span className="font-normal text-ink-2">· between the two</span></span>
                        <AutoText rows={3} value={written} disabled={writing} placeholder={main.type === "prompt" ? main.placeholder ?? "What happens in this stretch" : ""} onChange={(e) => onInputs({ ...stored, [main.id]: e.target.value })} className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-ink placeholder:text-ink-3 disabled:opacity-60" />
                      </label>
                    )}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {writing ? (
                        <span className="animate-pulse text-ink-2">The designer is writing what happens between…</span>
                      ) : (
                        <>
                          {onWriteBetween && (nextJoined || ends) && <Button size="sm" onClick={onWriteBetween} title="The designer writes the stretch from how the clip before ends to how the clip after starts, in the clip's time."><Wand2 size={13} /> {written ? "Designer: write it again" : "Designer: write it"}</Button>}
                          <Button size="sm" onClick={onDesigner}>Talk to the designer</Button>
                        </>
                      )}
                      {writeError && <span className="text-warn-ink">{writeError}</span>}
                    </div>
                    {seconds && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold">Duration</span>
                        <NumberBox label="Duration" value={Number(stored[seconds.id] ?? seconds.default)} min={seconds.min} max={seconds.max} step={seconds.step} unit=" s" onCommit={(v) => onInputs({ ...stored, [seconds.id]: v })} />
                      </div>
                    )}
                    {landing && nextJoined && landingOptions.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        <span className="flex items-baseline justify-between text-xs font-semibold">Landing <span className="font-normal text-ink-2">frames of clip {index + 2} it lands on</span></span>
                        <Segmented label="Landing" value={String(stored.landing ?? (landing.type === "choice" ? landing.default : "22"))} onChange={(v) => onInputs({ ...stored, landing: v })} options={landingOptions.map((o) => ({ value: o, label: o === "5" ? "Tight · 5" : o === "22" ? "Normal · 22" : o === "39" ? "Long · 39" : o }))} />
                      </div>
                    )}
                  </div>
                  <details className="group rounded-lg border border-line">
                    <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs font-semibold text-ink-2 hover:text-ink"><ChevronDown size={13} className="transition-transform group-open:rotate-180" /> All settings</summary>
                    <div className="border-t border-line p-2">{formElement}</div>
                  </details>
                </div>
              );
            })()}
          </>
        )}
        {(take || still) && (
          <div className="flex flex-col gap-2">
            <SectionTitle>Audio</SectionTitle>
            <Segmented
              label="Audio source"
              value={heard}
              options={[{ value: "own", label: still ? "Silent" : hasOwn ? "Own audio" : "Silent" }, { value: "file", label: "Audio file" }, ...(hasOwn ? [{ value: "muted" as const, label: "Muted" }] : [])]}
              onChange={(v) => (v === "file" ? (clip.soundAsset ? onPatch({ sound: "file" }) : setPicking("sound")) : onPatch({ sound: v }))}
            />
            {heard === "file" && clip.soundAsset && (
              <div className="flex items-center gap-2 rounded-lg border border-line bg-raised py-1.5 pr-1.5 pl-3">
                <Music size={13} className="shrink-0 text-ink-2" />
                <span className="min-w-0 grow truncate">{clip.soundAsset.name || "Audio file"}</span>
                <Button size="sm" onClick={() => setPicking("sound")}>Change</Button>
              </div>
            )}
            {(heard === "file" || (heard === "own" && hasOwn)) && <Slide label="Volume" value={clip.volume} max={100} show={(v) => `${v}%`} onCommit={(volume) => onPatch({ volume })} />}
            {!still && !hasOwn && heard !== "file" && <span className="text-xs text-ink-2">This clip has no audio of its own. Drop an audio file on it, or choose one.</span>}
          </div>
        )}

      </div>

      {recipe && !still && (
        <div className="flex shrink-0 flex-col gap-2 border-t border-line p-4">
          {error && <ErrorNote>{error}</ErrorNote>}
          {why && <div className="text-xs text-warn-ink">{why} {why.includes("ComfyUI") || why.includes("model") ? <Link href={why.includes("ComfyUI") ? "/settings" : "/settings/models"} className="font-semibold underline">Open Settings</Link> : null}</div>}
          {canFit && <Toggle on={fit} onChange={setFit} label={`End where clip ${index + 2} begins`} note="so that clip need not be redone" />}
          {!clip.job && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">Takes at once</span>
              <div className="w-40">
                <Segmented<"1" | "2" | "3"> label="Takes at once" value={String(count) as "1" | "2" | "3"} onChange={(v) => pickCount(Number(v) as 1 | 2 | 3)} options={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }]} />
              </div>
            </div>
          )}
          {whole && !clip.job && <FormModel recipe={recipe} input={whole} look={clip.look ?? timeline.look} />}
          {clip.job ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{running ? phaseLabel(running.phase) : "Queued"}</span>
                <span className="text-xs text-ink-2">{running?.steps ? `step ${running.step} of ${running.steps}` : ""}{running?.eta ? ` · ${about(running.eta)}` : ""}</span>
              </div>
              <Bar value={(running?.progress ?? 0) * 100} />
              <Button size="sm" className="self-start" onClick={onStop} title={running ? "Stop this render. Nothing is added; the clip keeps the takes it has." : "Remove it from the queue."}>
                {running ? "Stop render" : "Remove from queue"}
              </Button>
            </div>
          ) : (
            <Button tone="primary" className="h-11 text-sm" disabled={Boolean(why) || busy} onClick={() => onRender(fit, count)} title={count > 1 ? "The first take keeps the form's seed; the others get a fresh seed each. Pick the best in Takes." : undefined}>
              {busy ? "Sending…" : `${count > 1 ? `Render ${count} takes` : take ? "New take" : "Render this clip"}${takes ? ` · ${takes}` : ""}`}
            </Button>
          )}
        </div>
      )}

      {picking === "sound" && <Picker title={`Audio of clip ${index + 1}`} kind="audio" onClose={() => setPicking(null)} onPick={(soundAsset) => { onPatch({ soundAsset }); setPicking(null); }} />}
      {(picking === "start" || picking === "end" || picking === "mid") && (
        <Picker
          title={picking === "start" ? "First frame" : picking === "end" ? "Last frame" : "Keyframe"}
          onClose={() => setPicking(null)}
          onPick={(asset) => {
            onInputs({ ...stored, [pins[picking]!]: asset });
            setPicking(null);
          }}
        />
      )}
    </aside>
  );
}

/**
 * How the take looks, measured on its own frames when it was rendered, and how far it has moved from the
 * first clip of the run it flows on from (clips joined one after the other). For catching a chain that slides
 * darker, softer, duller or slower; a few per cent is the model's own variation.
 */
function LookTable({ timeline, index, take }: { timeline: Timeline; index: number; take: Take }) {
  const [open, setOpen] = useState(false);
  const m = take.measure!;
  let k = index;
  while (k > 0 && timeline.clips[k]!.joined === "continue") k--;
  const first = k < index ? timeline.clips[k]?.take?.measure ?? null : null;
  const signed = (x: number, digits = 1) => `${x < 0 ? "−" : "+"}${Math.abs(x).toFixed(digits)}`;
  const pct = (a: number | null | undefined, b: number | null | undefined, floor = 1) => (a == null || b == null ? null : `${a - b < 0 ? "−" : "+"}${Math.round((Math.abs(a - b) / Math.max(floor, Math.abs(b))) * 100)} %`);
  const diff = (a: number | null | undefined, b: number | null | undefined, unit = "") => (a == null || b == null ? null : `${signed(a - b)}${unit}`);
  const rows: Array<{ label: string; value: string; since: string | null; why: string; bad?: boolean }> = [
    { label: "Brightness", value: m.luma.toFixed(0), since: pct(m.luma, first?.luma), why: "Mean luma of the frames, 0 to 255." },
    { label: "Sharpness", value: m.sharp.toFixed(2), since: pct(m.sharp, first?.sharp, 0.01), why: "The mean absolute Laplacian of a small grey copy: 0 is flat, several units is crisp. A chain continued from exact latents loses it hop after hop." },
  ];
  if (m.range) rows.push({ label: "Range", value: `${m.range.low.toFixed(0)}–${m.range.high.toFixed(0)}`, since: first?.range ? diff(m.range.high - m.range.low, first.range.high - first.range.low) : null, why: "Where the darkest and the brightest tenth of the picture sit. A shrinking range is crushed blacks or clipped whites." });
  if (m.chroma) rows.push({ label: "Colour", value: `U ${signed(m.chroma.u)} · V ${signed(m.chroma.v)}`, since: first?.chroma ? `U ${diff(m.chroma.u, first.chroma.u)} · V ${diff(m.chroma.v, first.chroma.v)}` : null, why: "Mean chroma against neutral: U is blue (+) to yellow (−), V red (+) to green (−). A warming or greying chain shows here." });
  if (m.flicker != null) rows.push({ label: "Flicker", value: `${m.flicker.toFixed(1)} %`, since: diff(m.flicker, first?.flicker, " pt"), why: "How much the frame's mean brightness changes from one frame to the next. Exposure flicker is a known continuation artefact that averages hide." });
  if (m.pace != null) rows.push({ label: "Pace", value: m.pace.toFixed(1), since: pct(m.pace, first?.pace, 0.1), why: "Mean frame-to-frame change, the ruler's motion figure. H3 tends to slow down after each hand-over." });
  if (m.voice != null) rows.push({ label: "Voice", value: `${m.voice} Hz`, since: pct(m.voice, first?.voice, 1), why: "Where the sound's energy sits (its spectral centroid). A voice carried over several clips dulls before it changes: it drifts down." });
  if (m.drift) rows.push({ label: "Run-up", value: `×${m.drift.width.toFixed(3)}`, since: null, why: "A join made in the latent: how wide the regenerated run-up came out against the latent it was guided by. 1.000 is the same; a chain of exact latents reads 1.02 to 1.05 at every hop, which is the drift." });
  if (m.handover != null) rows.push({ label: "Run-up end", value: `×${m.handover.toFixed(1)}`, since: null, bad: m.handover > 3, why: "A continuation: how much the picture jumps where the run-up (the frames shared with the clip before; in a seamless take, that clip's own frames) ends and this clip's own frames begin, against its own motion right after. ×1 carries on; past ×3 the model stepped away from its guide and the join shows: re-render the take." });
  const brief = `${m.luma.toFixed(0)} luma · ${m.sharp.toFixed(1)} sharp${first ? ` · since clip ${k + 1}: ${pct(m.luma, first.luma)} / ${pct(m.sharp, first.sharp, 0.01)}` : ""}${m.handover != null && m.handover > 3 ? ` · run-up end ×${m.handover.toFixed(1)}` : ""}`;
  return (
    <div className="flex flex-col gap-2">
      {/* one line, folded: the table takes room that the form needs more often */}
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-2 text-left" title={open ? "Fold the figures" : "Every figure, with its meaning"}>
        <SectionTitle>Look</SectionTitle>
        <span className="min-w-0 grow truncate font-mono text-[11px] tabular-nums text-ink-3">{brief}</span>
        <ChevronDown size={13} className={cx("shrink-0 text-ink-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
      <table className="w-full text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} title={r.why}>
              <td className="py-0.5 text-ink-2">{r.label}</td>
              <td className={cx("py-0.5 text-right font-mono tabular-nums", r.bad && "text-warn-ink")}>{r.value}</td>
              <td className="py-0.5 pl-3 text-right font-mono tabular-nums text-ink-3">{r.since ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      )}
      {open && <Note text={first ? `Measured on this take's own frames. The last column is the change since clip ${k + 1}, the first of this run; a few per cent is the model's own variation. Hover a row for what it means.` : "Measured on this take's own frames when it was rendered. Hover a row for what it means."} />}
    </div>
  );
}

/** A place a picture can be dropped on to become a pinned frame: one from the library, or a file from the computer, which goes into the library first. */
function PinDrop({ className, onPick, children }: { className?: string; onPick(id: string): void; children: ReactNode }) {
  const upload = useMutation({ mutationFn: (file: File) => api.upload(file, { project: projectForNew() }), onSuccess: (a) => onPick(a.id) });
  const drop = useDropZone([DRAG_PICTURE], onPick, (file) => file.type.startsWith("image/") && upload.mutate(file));
  return (
    <div {...drop.props} className={cx(className, drop.zone, drop.wanted && "ring-1 ring-accent/50")} title={drop.wanted ? "Drop the picture here" : undefined}>
      {children}
      {upload.isPending && <span className="ml-1 text-xs text-ink-2">Adding…</span>}
    </div>
  );
}

/** A clip's takes, the one that plays marked: hovered, one is previewed in the player; clicked, it plays. Each says how its joins jump, and can be removed. */
function TakeList({ clip, take, joinOf, smoothest, onPreview, onPatch, onRemoveTake }: {
  clip: Clip;
  take: Take | null;
  joinOf(take: string): { in: number | null; out: number | null } | undefined;
  /** The take whose joins jump least, once measured. */
  smoothest: string | null;
  onPreview(take: Take | null): void;
  onPatch(patch: ShownPatch): void;
  onRemoveTake(id: string): void;
}) {
  return (
    <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-start gap-2">
              {clip.takes.map((t, i) => {
                const on = t.id === take?.id;
                return (
                  <div key={t.id} className="relative" onMouseEnter={() => !on && onPreview(t)} onMouseLeave={() => onPreview(null)}>
                    <button
                      type="button"
                      aria-pressed={on}
                      aria-label={on ? `Take ${i + 1}, the one that plays` : `Play take ${i + 1} instead`}
                      onFocus={() => !on && onPreview(t)}
                      onBlur={() => onPreview(null)}
                      onClick={() => {
                        onPreview(null);
                        if (!on) onPatch({ take: t.id });
                      }}
                      className="flex w-[68px] flex-col gap-1 text-left"
                    >
                      <span className="relative">
                        <img src={thumbUrl(t.asset.id)} alt="" loading="lazy" className={cx("h-[84px] w-[68px] rounded-md border-2 object-cover", on ? "border-accent" : "border-line hover:border-line-strong")} />
                        {smoothest === t.id && clip.takes.length > 1 && <span className="absolute bottom-1 left-1 rounded bg-good px-1 py-px text-[9px] font-bold leading-tight text-ground" title="The smoothest joins of the takes">smoothest</span>}
                        {t.finishedFrom && <span className="absolute top-1 left-1 rounded bg-accent px-1 py-px text-[9px] font-bold leading-tight text-accent-ink" title={`The finished version of take ${Math.max(1, clip.takes.findIndex((x) => x.id === t.finishedFrom) + 1)}: the same clip, brought to its final quality (${t.asset.width} × ${t.asset.height})`}>finished</span>}
                      </span>
                      <span className={cx("text-[11px]", on ? "font-semibold text-accent" : "text-ink-2")}>{on ? "plays" : `take ${i + 1}`}</span>
                      {(() => {
                        const j = joinOf(t.id);
                        if (!j || (j.in === null && j.out === null)) return null;
                        const bad = (v: number | null) => v !== null && v >= 2.5;
                        return (
                          <span className="flex items-center gap-1 font-mono text-[10px] leading-none" title="How much the picture jumps at each join, against the clip's own motion: ×1 moves like the clip, ×2.5 and up is a visible catch.">
                            {j.in !== null && <span className={bad(j.in) ? "text-warn-ink" : "text-ink-3"}>in ×{j.in}</span>}
                            {j.out !== null && <span className={bad(j.out) ? "text-warn-ink" : "text-ink-3"}>out ×{j.out}</span>}
                          </span>
                        );
                      })()}
                    </button>
                    <button type="button" aria-label={`Remove take ${i + 1}`} title="Remove this take. Its video goes to the bin with it; Undo brings both back." onClick={() => onRemoveTake(t.id)} className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-ground/80 text-ink-2 hover:text-ink">
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
    </div>
  );
}

/** How long a still is held; how long a take plays and how much is trimmed off its start, with Reset. */
function Duration({ clip, take, room, rendered, onPatch }: { clip: Clip; take: Take | null; room: number; rendered: boolean; onPatch(patch: ShownPatch): void }) {
  if (clip.kind === "still") {
    return (
    <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <span>Held on screen for</span>
                <NumberBox label="How long the still is held, in seconds" value={clip.lengthMs / 1000} min={0.5} max={60} step={0.1} unit="s" onCommit={(v) => onPatch({ stillMs: Math.round(v * 1000) })} />
              </div>
    </div>
    );
  }
  if (!take) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span>Plays</span>
        {/* asked by what is seen: the server works out the trim, whatever a landing or a seamless join moves */}
        <NumberBox label="How long the clip plays, in seconds" value={clip.lengthMs / 1000} min={0.3} max={Math.max(0.3, (take.headMs + room - take.startMs) / 1000)} step={0.1} unit="s" onCommit={(v) => onPatch({ shownToMs: take.startMs + Math.round(v * 1000) })} />
        <span className="text-ink-2">of {(room / 1000).toFixed(1)} s, from</span>
        <NumberBox label="How much is trimmed from the start, in seconds" value={take.trimStartMs / 1000} min={0} max={Math.max(0, (room - take.trimEndMs - 300) / 1000)} step={0.1} unit="s" onCommit={(v) => onPatch({ trimStartMs: Math.round(v * 1000) })} />
        <Help text={`Or drag the clip's edges on the timeline. This trims what plays${rendered ? "; to make the clip itself longer, change Duration in Output and render a new take" : ""}.`} />
        {(take.trimStartMs > 0 || take.trimEndMs > 0) && <Button size="sm" onClick={() => onPatch({ trimStartMs: 0, trimEndMs: 0 })}>Reset trim</Button>}
      </div>
    </div>
  );
}

/** The pictures pinned on a clip's form: its first and last frame and a keyframe, each changed, dropped on or removed. */
function PinnedFrames({ stored, pins, frames, midDefault, onInputs, onPick }: {
  stored: Record<string, unknown>;
  pins: ReturnType<typeof pinInputs>;
  /** The pictures pinned now (its opening one only when it does not carry on from the clip before), whether it loops, whether it carries on. */
  frames: { opens: string | null; ends: string | null; through: string | null; loops: boolean; carries: boolean };
  midDefault: number;
  onInputs(next: Record<string, unknown>): void;
  onPick(where: "start" | "end" | "mid"): void;
}) {
  const { opens, ends, through, loops, carries } = frames;
  const without = (id: string | undefined) => Object.fromEntries(Object.entries(stored).filter(([k]) => k !== id));
  const setPicking = onPick;
  return (
    <div className="flex flex-col gap-2">
            {[{ where: "start" as const, id: opens, input: pins.start, text: "First frame" }, { where: "end" as const, id: ends, input: pins.end, text: loops ? "Last frame, same as the first: it loops" : "Last frame" }].map((p) =>
              p.id ? (
                <PinDrop key={p.where} className="flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5" onPick={(id) => onInputs({ ...stored, [p.input!]: id })}>
                  <img src={thumbUrl(p.id)} alt="" className="h-11 w-11 rounded-md object-cover" />
                  <span className="grow">{p.text}</span>
                  <Button size="sm" onClick={() => setPicking(p.where)}>Change</Button>
                  <button type="button" aria-label="Remove this pinned frame" onClick={() => onInputs(without(p.input))} className="flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover"><X size={14} /></button>
                </PinDrop>
              ) : null,
            )}
            {through && pins.mid && pins.midAt && (
              <PinDrop className="flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5" onPick={(id) => onInputs({ ...stored, [pins.mid!]: id })}>
                <img src={thumbUrl(through)} alt="" className="h-11 w-11 rounded-md object-cover" />
                <span className="grow">Keyframe at</span>
                <NumberBox label="When the clip reaches this keyframe, in seconds" value={Number(stored[pins.midAt] ?? midDefault)} min={0.5} max={14.5} step={0.5} unit="s" onCommit={(v) => onInputs({ ...stored, [pins.midAt!]: v })} />
                <button type="button" aria-label="Remove this pinned frame" onClick={() => onInputs(without(pins.mid))} className="flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover"><X size={14} /></button>
              </PinDrop>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {/* each takes a picture dropped on it: from the library, or a file from the computer */}
              {pins.start && !carries && !opens && <PinDrop className="rounded-lg" onPick={(id) => onInputs({ ...stored, [pins.start!]: id })}><Button size="sm" onClick={() => setPicking("start")}><ImagePlus size={13} /> First frame</Button></PinDrop>}
              {pins.mid && !through && <PinDrop className="rounded-lg" onPick={(id) => onInputs({ ...stored, [pins.mid!]: id })}><Button size="sm" onClick={() => setPicking("mid")}><ImagePlus size={13} /> Keyframe</Button></PinDrop>}
              {pins.end && !ends && <PinDrop className="rounded-lg" onPick={(id) => onInputs({ ...stored, [pins.end!]: id })}><Button size="sm" onClick={() => setPicking("end")}><ImagePlus size={13} /> Last frame</Button></PinDrop>}
            </div>
    </div>
  );
}
