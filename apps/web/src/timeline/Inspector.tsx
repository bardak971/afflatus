import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ChevronDown, ImagePlus, Link2, Music, Repeat, Scissors, Trash2, Wand2, X } from "lucide-react";
import { secondsInput } from "@afflatus/core";
import { thumbUrl, type Clip, type ClipPatch, type RecipeInfo, type RunningJob, type Take, type Timeline, type TimelinePatch } from "../api";
import { useEntities, useRecipes, useSetup } from "../data";
import { WritingHelp } from "../Designer";
import { appendTo } from "../promptText";
import { LookBar, lookWords } from "../LookBar";
import { FormModel } from "../ModelLoad";
import { about, aboutMs, clock, phaseLabel, recipeLabel } from "../format";
import { Picker } from "../PictureField";
import { Form, mainTextOf } from "../RecipeForm";
import { Select } from "../Select";
import { AutoText, Bar, Button, cx, ErrorNote, NumberBox, PanelEdge, SectionTitle, Segmented, Toggle } from "../ui";
import { usePanelWidth } from "../store";
import { otherShape, pinInputs, shapeOf } from "./model";

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
        <Toggle on={m.duck} onChange={(duck) => onEdit({ music: { duck } })} label="Duck under speech" note="quieter while people talk; heard in the exported video" />
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

export function Inspector({ timeline, clip, index, recipes, stored, whole, why, takesMs, running, busy, error, onInputs, onRecipe, onPatch, onRender, onRemove, onRemoveTake, onStop, onLoop, onPreview, onDesigner, writing, writeError, onWriteBetween }: {
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
  onPatch(patch: ClipPatch): void;
  /** Render it: `count` takes at once (the first with the form's seed, the others with a fresh one each). */
  onRender(fit: boolean, count: number): void;
  onRemove(): void;
  onRemoveTake(id: string): void;
  /** Stop the render of this clip that is under way, or take it out of the queue. */
  onStop(): void;
  /** Make the clip end where it begins: on its opening picture, or on the first frame of its take. */
  onLoop(): void;
  /** A take is hovered: show it in the player without choosing it. */
  onPreview(take: Take | null): void;
  /** Open the designer for this clip. */
  onDesigner(): void;
  /** The designer is writing what happens between the clips around (a clip put between two others). */
  writing?: boolean;
  writeError?: string | null;
  /** Ask the designer to write it (again). */
  onWriteBetween?(): void;
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
  const [removing, setRemoving] = useState(false);
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
  /** How much of the take can play at most: its video without the parts it shares with its neighbours. */
  const room = take ? (take.asset.durationMs ?? 0) - take.headMs - take.tailMs : 0;
  const without = (id: string | undefined) => Object.fromEntries(Object.entries(stored).filter(([k]) => k !== id));
  const shapes = { tall: "portrait", wide: "landscape", square: "square" } as const;
  const shown = still ? clip.still : take?.asset;
  const misfit = otherShape(clip, timeline) && shown?.width && shown.height && timeline.width && timeline.height
    ? `This ${still ? "still" : "clip"} is ${shapes[shapeOf(shown.width, shown.height)]}, the video is ${shapes[shapeOf(timeline.width, timeline.height)]}.`
    : null;
  const hasOwn = Boolean(take?.asset.hasSound);
  const heard = clip.sound === "file" ? "file" : clip.sound === "muted" && hasOwn ? "muted" : "own";

  return (
    <aside data-designer-stays style={{ width: panelWidth }} className="relative flex shrink-0 flex-col border-l border-line bg-panel">
      <PanelEdge side="left" />
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <span className="font-semibold">{still ? "Still" : "Clip"} {index + 1}</span>
        <span className="text-ink-2">{clip.lengthMs ? `${(clip.lengthMs / 1000).toFixed(1)} s` : "not rendered yet"}</span>
        <span className="grow" />
        {removing ? (
          <>
            <span className="text-xs text-ink-2">{still ? "The image stays in your library." : "Its videos stay in your library."}</span>
            <button type="button" onClick={onRemove} className="rounded-md bg-warn px-2 py-1 text-xs font-bold text-warn-on">Remove</button>
            <button type="button" onClick={() => setRemoving(false)} className="rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-hover">Cancel</button>
          </>
        ) : (
          <button type="button" aria-label="Remove from timeline" title="Remove from timeline" onClick={() => setRemoving(true)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink">
            <Trash2 size={15} />
          </button>
        )}
      </div>

      <div className="flex min-h-0 grow flex-col gap-3.5 overflow-y-auto p-4">
        {still && clip.still && (
          <>
            <img src={thumbUrl(clip.still.id)} alt={clip.still.name} className="max-h-56 self-start rounded-lg" />
            <span className="text-ink-2">A still: an image held on screen.</span>
            <span><Button onClick={() => onPatch({ animate: true })}>Image to video (i2v)</Button></span>
          </>
        )}

        {before && !still && (
          <div className={cx("flex flex-col gap-2 rounded-lg border p-3", clip.join === "stale" ? "border-warn bg-warn-wash" : "border-line")}>
            {clip.join === "stale" ? (
              <>
                <span className="font-semibold text-warn-ink">This clip no longer follows clip {index}</span>
                <span className="text-xs text-ink-2">Clip {index} changed after this one was rendered, so {before.kind === "still" ? "its first frame is no longer that image" : "the motion jumps between them"}.</span>
                <span className="flex flex-wrap gap-1.5">
                  {recipe && <Button size="sm" tone="danger" disabled={Boolean(why) || busy || Boolean(clip.job)} onClick={() => onRender(fit, count)}>Re-render{takes ? ` · ${takes}` : ""}</Button>}
                  <Button size="sm" onClick={() => onPatch({ joined: "cut" })}>Keep as a cut</Button>
                </span>
              </>
            ) : carries ? (
              <>
                <span className="flex items-center gap-2 font-semibold"><Link2 size={14} className="text-accent" /> {take ? "Extends" : "Will extend"} clip {index}</span>
                <span className="text-xs text-ink-2">
                  {!canCarry
                    ? "The model of this clip cannot extend another clip: it will start on its own."
                    : before.kind === "still"
                      ? `Its first frame is the image of clip ${index}.`
                      : recipe?.traits?.continues === "clip"
                        ? `It starts from the last moments of clip ${index}: the motion and the voices continue across the join.`
                        : `Its first frame is the last frame of clip ${index}.`}
                </span>
                <span><Button size="sm" onClick={() => onPatch({ joined: "cut" })}><Scissors size={13} /> Make it a cut</Button></span>
              </>
            ) : (
              <>
                <span className="flex items-center gap-2 font-semibold"><Scissors size={14} className="text-ink-2" /> Cut</span>
                <span className="text-xs text-ink-2">Nothing ties it to clip {index}: it starts on its own.</span>
                {canCarry && <span><Button size="sm" onClick={() => onPatch({ joined: "continue" })}><Link2 size={13} /> Extend clip {index}</Button></span>}
              </>
            )}
          </div>
        )}

        {clip.failed && !clip.job && <ErrorNote>The last render failed: {clip.failed}</ErrorNote>}

        {misfit && (
          <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <span>{misfit} {clip.fill ? "It fills the frame: its edges are cropped." : "It is letterboxed: shown whole, with bars."}</span>
            <Toggle on={clip.fill} onChange={(fill) => onPatch({ fill })} label="Fill frame (crop)" />
          </div>
        )}

        {clip.takes.length > 0 && (
          <div className="flex flex-col gap-2">
            <SectionTitle>Takes</SectionTitle>
            <div className="flex flex-wrap gap-2">
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
                      <img src={thumbUrl(t.asset.id)} alt="" loading="lazy" className={cx("h-[84px] w-[68px] rounded-md border-2 object-cover", on ? "border-accent" : "border-line hover:border-line-strong")} />
                      <span className={cx("text-[11px]", on ? "font-semibold text-accent" : "text-ink-2")}>{on ? "plays" : `take ${i + 1}`}</span>
                    </button>
                    <button type="button" aria-label={`Remove take ${i + 1}`} title="Remove this take. Its video goes to the bin with it; Undo brings both back." onClick={() => onRemoveTake(t.id)} className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-ground/80 text-ink-2 hover:text-ink">
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
            <span className="text-xs text-ink-3">{clip.takes.length > 1 ? "Hover a take to preview it, click to make it play." : "Each render adds a take. The one you pick plays."}</span>
          </div>
        )}

        {(still || take) && (
          <div className="flex flex-col gap-2">
            <SectionTitle>Duration</SectionTitle>
            {still ? (
              <div className="flex items-center justify-between gap-3">
                <span>Held on screen for</span>
                <NumberBox label="How long the still is held, in seconds" value={clip.lengthMs / 1000} min={0.5} max={60} step={0.1} unit="s" onCommit={(v) => onPatch({ stillMs: Math.round(v * 1000) })} />
              </div>
            ) : take ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span>Plays <span className="text-ink-2">of {(room / 1000).toFixed(1)} s</span></span>
                  <NumberBox label="How long the clip plays, in seconds" value={clip.lengthMs / 1000} min={0.3} max={Math.max(0.3, (room - take.trimStartMs) / 1000)} step={0.1} unit="s" onCommit={(v) => onPatch({ trimEndMs: Math.max(0, room - take.trimStartMs - Math.round(v * 1000)) })} />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Trim start</span>
                  <NumberBox label="How much is trimmed from the start, in seconds" value={take.trimStartMs / 1000} min={0} max={Math.max(0, (room - take.trimEndMs - 300) / 1000)} step={0.1} unit="s" onCommit={(v) => onPatch({ trimStartMs: Math.round(v * 1000) })} />
                </div>
                {(take.trimStartMs > 0 || take.trimEndMs > 0) && <span><Button size="sm" onClick={() => onPatch({ trimStartMs: 0, trimEndMs: 0 })}>Reset trim</Button></span>}
              </>
            ) : null}
            <span className="text-xs text-ink-3">
              {still ? "Or drag its edge on the timeline." : `Or drag the clip's edges on the timeline. This trims what plays${recipe ? "; to make the clip itself longer, change Duration below and render a new take" : ""}.`}
            </span>
          </div>
        )}

        {recipe && !still && (pins.start || pins.end) && (
          <div className="flex flex-col gap-2">
            <SectionTitle>Pinned frames</SectionTitle>
            {[{ where: "start" as const, id: opens, input: pins.start, text: "First frame" }, { where: "end" as const, id: ends, input: pins.end, text: loops ? "Last frame, same as the first: it loops" : "Last frame" }].map((p) =>
              p.id ? (
                <div key={p.where} className="flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5">
                  <img src={thumbUrl(p.id)} alt="" className="h-11 w-11 rounded-md object-cover" />
                  <span className="grow">{p.text}</span>
                  <Button size="sm" onClick={() => setPicking(p.where)}>Change</Button>
                  <button type="button" aria-label="Remove this pinned frame" onClick={() => onInputs(without(p.input))} className="flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover"><X size={14} /></button>
                </div>
              ) : null,
            )}
            {through && pins.mid && pins.midAt && (
              <div className="flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5">
                <img src={thumbUrl(through)} alt="" className="h-11 w-11 rounded-md object-cover" />
                <span className="grow">Keyframe at</span>
                <NumberBox label="When the clip reaches this keyframe, in seconds" value={Number(stored[pins.midAt] ?? (midSpec?.type === "number" ? midSpec.default : 2.5))} min={0.5} max={14.5} step={0.5} unit="s" onCommit={(v) => onInputs({ ...stored, [pins.midAt!]: v })} />
                <button type="button" aria-label="Remove this pinned frame" onClick={() => onInputs(without(pins.mid))} className="flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover"><X size={14} /></button>
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {pins.start && !carries && !opens && <Button size="sm" onClick={() => setPicking("start")}><ImagePlus size={13} /> First frame</Button>}
              {pins.mid && !through && <Button size="sm" onClick={() => setPicking("mid")}><ImagePlus size={13} /> Keyframe</Button>}
              {pins.end && !ends && <Button size="sm" onClick={() => setPicking("end")}><ImagePlus size={13} /> Last frame</Button>}
              {pins.end && !loops && (
                <Button
                  size="sm"
                  disabled={!opens && !take}
                  title={opens ? "The last frame will be the first frame, so the clip can be played round and round." : take ? "The last frame will be the first frame of its take, so the clip can be played round and round." : "Give the clip a first frame, or render it once: a loop ends where the clip begins."}
                  onClick={onLoop}
                >
                  <Repeat size={13} /> Make it loop
                </Button>
              )}
            </div>
            <span className="text-xs text-ink-3">
              {carries && pins.start ? `It extends clip ${index}, so it needs no first frame. ` : ""}
              Or drop an image on the clip: near its start for the first frame, near its end for the last frame{pins.mid ? ", in the middle for a keyframe" : ""}.
              {take ? " A pinned frame counts from the next take." : ""}
            </span>
          </div>
        )}

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
              const joins = !take && (carries || Boolean(opens) || Boolean(ends) || nextJoined);
              const leftFrame = opens ? thumbUrl(opens) : carries && before ? (before.kind === "still" && before.still ? thumbUrl(before.still.id) : before.take ? `/api/assets/${before.take.asset.id}/peek?at=${Math.max(0, Math.round(before.take.endMs - 20))}&h=160` : null) : null;
              const rightFrame = ends ? thumbUrl(ends) : nextJoined && after?.take ? `/api/assets/${after.take.asset.id}/peek?at=${Math.round(after.take.startMs)}&h=160` : null;
              const startsHow = carries ? `Extends clip ${index}: its motion carries in` : opens ? `Opens on a picture` : "Starts on its own";
              const endsHow = nextJoined ? `ends where clip ${index + 2} begins` : ends ? "ends on a picture" : "ends free";
              const seconds = secondsInput(form.inputs);
              const landing = recipe.inputs.find((i) => i.id === "landing" && i.type === "choice");
              const landingOptions = landing && landing.type === "choice" && Array.isArray(landing.options) ? landing.options : [];
              const formElement = (
                  <Form
                    key={`${clip.id}:${form.id}`}
                    recipe={form}
                    status={status}
                    stored={stored}
                    onChange={(input, value) => onInputs({ ...stored, [input]: value })}
                    onClear={(inputs) => onInputs(Object.fromEntries(Object.entries(stored).filter(([k]) => !inputs.includes(k))))}
                    made={picker}
                    madeSummary={recipeLabel(all.data?.families.find((f) => f.id === recipe.family)?.name, recipe.title)}
                    look={cast}
                    lookSummary={lookWords(clip.look ?? timeline.look, entities.data?.items ?? []) + (clip.look === null && timeline.look ? " (from the timeline)" : "")}
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
              );
              if (!joins) return <div className="flex flex-col gap-2.5">{formElement}</div>;
              return (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2.5 rounded-xl border border-accent/40 bg-accent-wash/30 p-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-raised">{leftFrame ? <img src={leftFrame} alt="" className="h-full w-full object-cover" /> : <span className="text-[10px] text-ink-3">—</span>}</div>
                      <div className="flex min-w-0 grow flex-col gap-0.5 text-xs">
                        <span className="font-semibold">Join</span>
                        <span className="text-ink-2">{startsHow} · {endsHow}.</span>
                      </div>
                      <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-raised">{rightFrame ? <img src={rightFrame} alt="" className="h-full w-full object-cover" /> : <span className="text-[10px] text-ink-3">—</span>}</div>
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
