import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair } from "lucide-react";
import { windowBounds } from "@afflatus/core";
import type { DesignerSession, Look, RecipeInfo, SourcePatch, Timeline } from "../../api";
import type { DesignerTurn } from "../../designer/types";
import { useQueue, useRecipes, useSetup } from "../../data";
import { timelineKey } from "../../draftMachine";
import { RenderOn, usePickedMachine } from "../../GenerateOn";
import { severalMachines } from "../../machines";
import { clock as mmss, plural, recipeLabel } from "../../format";
import { PictureMaker, usePictureSets } from "../../pictureMaker";
import { appendTo } from "../../promptText";
import { Form, mainTextOf } from "../../RecipeForm";
import { CardPrompt } from "../../recipeForm/Part";
import { Select } from "../../Select";
import { Button, cx, Toggle } from "../../ui";
import { WritingHelp } from "../../WritingHelp";
import { useClockAs, type Clock } from "../clock";
import { ColumnEdge, FoldButton, useColumnWidth } from "../column";
import { windowed, type SourcePlace } from "../track/SourceLane";
import { CloseButton, Slide } from "./parts";

const Designer = lazy(() => import("../../Designer").then((m) => ({ default: m.Designer })));

/**
 * The clips the source is made into, as its summary says them: "3 clips of 5.0 s", "2 clips of 4.6–5.0 s". From the windows
 * themselves, not the slider's length: a stretch shorter than the window asked for read "1 clip of 19.7 s" for 5.1 s.
 */
export function windowsSaid(windows: ReadonlyArray<{ fromMs: number; toMs: number }>, windowMs: number): string {
  const lengths = windows.map((w) => (w.toMs - w.fromMs) / 1000);
  // made already (its clips are on the track): the window it was made with
  if (!lengths.length) return `windows of ${(windowMs / 1000).toFixed(1)} s`;
  const [least, most] = [Math.min(...lengths).toFixed(1), Math.max(...lengths).toFixed(1)];
  return `${plural(windows.length, "clip")} of ${least === most ? least : `${least}–${most}`} s`;
}

/**
 * The source lane opened in the column, as a clip's panel: the model's whole form (its cards, the Designer on its prompt)
 * that every window is made with, its driving video being the source's (each window its part); the source's own chapter
 * first (the stretch, the window, scene cuts); and Make N clips at the foot. The stage plays the source meanwhile, and a
 * picture is made from the frame the playhead stands on. Each made clip keeps its own form afterwards.
 */
export function SourcePanel({ timeline, place, recipes, clock, onEdit, onType, typed, onLook, onMake, making, made, onRender, rendering, onClose, picking, onPicking }: {
  timeline: Timeline;
  place: SourcePlace | null;
  /** The video models of this timeline: those that make a source window by window are offered. */
  recipes: RecipeInfo[];
  /** The timeline's clock: where the stage stands on the source (the track's own time). */
  clock: Clock;
  onEdit(patch: SourcePatch | null): void;
  /** Its form typed: kept by the editor and saved as the clips' forms are (useClipEdits), so that closing the panel loses none of it. */
  onType(inputs: Record<string, unknown>): void;
  /** Its form as typed and not saved yet, if so: what the panel opens on, over what the server had. */
  typed(): Record<string, unknown> | undefined;
  onLook(look: Look): void;
  /** The clips made: sent to render at once, or (`andRender` false) the first opened, its form every clip's. */
  onMake(andRender?: boolean): void;
  making: boolean;
  /** Once made: how many of its clips have nothing to play and wait for no render, and how many are in the queue. */
  made: { left: number; queued: number };
  /** Its clips that have nothing to play sent to render, as Render all sends them (where the timeline's slice says). */
  onRender(): void;
  rendering: boolean;
  onClose(): void;
  /** The stage waits for a click on the person a swap replaces (SourceStage's picking). */
  picking: boolean;
  onPicking(on: boolean): void;
}) {
  const panelWidth = useColumnWidth();
  const several = severalMachines(useQueue().data).length > 0;
  // the machine picked for the timeline's renders: the form's node pack notes speak for it
  const pickedOn = usePickedMachine(timelineKey(timeline.id));
  const all = useRecipes();
  const setup = useSetup();
  const source = timeline.source;
  const models = recipes.filter((r) => windowed(r));
  const recipe = models.find((r) => r.id === source?.recipe);
  // a source without a model yet takes the first that can make it
  useEffect(() => {
    if (source && !recipe && models[0]) onEdit({ recipe: models[0].id });
  }, [source?.asset, recipe, models[0]?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- once a source has no model
  const w = windowed(recipe);
  // the form without what the source gives each window (its driving video and its part) and what a timeline fills in
  const form = useMemo(
    () => (recipe && w ? { ...recipe, inputs: recipe.inputs.filter((i) => i.type !== "clip" && i.id !== w.start && i.id !== w.seconds) } : undefined),
    [recipe, w?.start, w?.seconds], // eslint-disable-line react-hooks/exhaustive-deps -- w follows the recipe
  );
  // what is typed, shown at once and handed to the editor, which saves it once it stops changing (one step for Undo, not
  // one a key), as the editor is left or the tab closes, and before Make
  const [inputs, shownInputs] = useState<Record<string, unknown>>(() => typed() ?? source?.inputs ?? {});
  const latest = useRef(inputs);
  const setInputs = (edit: (x: Record<string, unknown>) => Record<string, unknown>) => {
    const next = edit(latest.current);
    latest.current = next;
    shownInputs(next);
    onType(next);
  };
  // the server's form read again (an Undo, another tab) is shown, unless something typed here is still to be saved: a read
  // back from before its save would put the older text over it
  const read = useRef(JSON.stringify(source?.inputs ?? {}));
  useEffect(() => {
    const now = JSON.stringify(source?.inputs ?? {});
    if (now === read.current) return;
    read.current = now;
    if (typed()) return;
    latest.current = source?.inputs ?? {};
    shownInputs(latest.current);
  }, [source?.inputs]); // eslint-disable-line react-hooks/exhaustive-deps -- typed() is read as the server's form changes
  const [designing, setDesigning] = useState(false);
  const [turns, setTurns] = useState<DesignerTurn[]>([]);
  const [session, setSession] = useState<DesignerSession | null>(null);
  const status = setup.data?.recipes.find((r) => r.id === recipe?.id);
  const name = (r: RecipeInfo) => recipeLabel(all.data?.families.find((f) => f.id === r.family)?.name, r.title);
  const pictureSpec = recipe?.inputs.find((i) => i.type === "image" && i.role === "source");
  const picture = pictureSpec ? (inputs[pictureSpec.id] as string | undefined) : undefined;
  const windows = place?.windows ?? [];
  // the window lengths the model takes, on the slider's steps (windowBounds: a window asked for outside them is made as the nearest)
  // with the run-up as set on the form: it is what a window takes past its carried frames
  const bounds = w ? windowBounds(windowed(recipe, inputs)!.shape) : { leastMs: 1000, mostMs: 5000 };
  const leastMs = Math.max(1000, Math.ceil(bounds.leastMs / 100) * 100);
  const mostMs = Math.max(leastMs, Math.floor(bounds.mostMs / 100) * 100);
  const windowMs = source ? Math.min(Math.max(source.windowMs, leastMs), mostMs) : mostMs;
  const main = form ? mainTextOf(form) : undefined;
  const written = main ? String(inputs[main.id] ?? (main.type === "prompt" ? main.default ?? "" : "")) : "";
  // a model with no Picture of its own (a swap) has no source form: its clips' form is the one, every clip sharing what
  // changes in it (the owner, 2026-10-18). Here only what is the source's: the model, the stretch and who is replaced
  const formless = Boolean(recipe && !pictureSpec);
  // a model whose driving video takes a click on its first frame (a swap): who is replaced, picked on the stage
  const drivingSpec = recipe?.inputs.find((i) => i.id === w?.driving);
  const takesPick = drivingSpec?.type === "clip" && Boolean(drivingSpec.pick);
  // what Make waits for: the person a swap replaces, the Picture of a model that takes one (Motion transfer), the words a model
  // needs (a swap's who to replace)
  const waitsFor = takesPick && !source?.pick && !place?.made ? "Pick who is replaced first: click him or her on the stage."
    : pictureSpec && !picture ? `Choose the ${pictureSpec.label.toLowerCase()} first.` : !formless && main && main.type === "prompt" && !main.optional && !written.trim() ? `Write ${main.label.toLowerCase()} first.` : null;

  const sourceChapter = source ? {
    id: "source",
    title: "Source",
    help: "The stretch of the video made into clips, one a window, each carrying on from the one before. Drag the source on its lane to choose where Motion transfer starts, its right end where it stops; or split it at the playhead (right-click the lane).",
    summary: `${mmss(source.fromMs, { decimals: 1 })}–${mmss(source.toMs, { decimals: 1 })} · ${windowsSaid(windows, windowMs)}`,
    node: (
      <div className="flex flex-col gap-3">
        {takesPick && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold">Who is replaced</span>
            {picking ? (
              <Button tone="plain" className="h-11 justify-start gap-2 border-accent! px-3" onClick={() => onPicking(false)}>
                <Crosshair size={16} className="text-accent" aria-hidden />
                <span className="grow text-left"><span className="font-semibold">Picking</span><span className="text-ink-2"> · click the person on the stage</span></span>
                <kbd className="font-mono text-meta text-ink-3">Esc</kbd>
              </Button>
            ) : source.pick ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="grow text-xs text-ink-2">
                  Picked on the first frame ({mmss(source.fromMs, { decimals: 1 })}), marked on the stage; the clips after it follow the same person
                </span>
                <Button size="sm" onClick={() => onPicking(true)}>Pick again</Button>
                <Button size="sm" tone="quiet" onClick={() => onEdit({ pick: null })}>Clear</Button>
              </div>
            ) : (
              <Button className="h-11 justify-start gap-2 px-3" onClick={() => onPicking(true)}>
                <Crosshair size={16} aria-hidden />
                Pick on the stage
              </Button>
            )}
          </div>
        )}
        <Slide label="Window" value={windowMs} min={leastMs} max={mostMs} step={100} show={(ms) => `${(ms / 1000).toFixed(1)} s`} onCommit={(windowMs) => onEdit({ windowMs })} />
        <Toggle on={source.snap} onChange={(snap) => onEdit({ snap })} label="Cut at scene changes" note={source.snap ? "a window ends at a cut in the source; the next one opens a new shot" : "windows of the same length, end to end"} />
        <span className="text-xs text-ink-2">
          {place?.made
            ? "Made: the clips above carry its parts (outlined on the lane)."
            : `${windows.map((x, k) => `${k + 1}: ${mmss(x.fromMs, { decimals: 1 })}–${mmss(x.toMs, { decimals: 1 })}`).join(" · ")}. Each carries on from the one before (its last frames), with this form and one seed; ${place?.replaces ? "they take the place of the clip the stretch was taken from" : "they go after the last clip"}, dashed on the track.`}
        </span>
      </div>
    ),
  } : { id: "source", title: "Source", summary: "", node: null };

  return (
    <aside data-designer-stays style={{ width: panelWidth }} className="relative flex shrink-0 flex-col border-l border-line bg-panel">
      <ColumnEdge />
      <div className="flex shrink-0 items-start gap-2 border-b border-line px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 grow flex-wrap items-center gap-1.5 pt-0.5">
          <span className="mr-0.5 flex h-6 shrink-0 items-center rounded-chip bg-accent-wash px-2 text-xs font-bold text-accent uppercase">Source</span>
          <span className="truncate font-semibold">{source?.video.name ?? "none yet"}</span>
        </div>
        <FoldButton />
        <span className="ml-1.5 flex shrink-0 border-l border-line pl-1.5"><CloseButton onClose={onClose} /></span>
      </div>

      {designing && recipe && source && w && (
        <Suspense fallback={null}>
          <Designer
            side="inline"
            draftKey={`source:${timeline.id}`}
            recipe={recipe}
            // the form one window has: the picture it reads, the prompt it writes, the source's part
            values={{ ...inputs, [w.driving]: { asset: source.asset }, [w.start]: source.fromMs / 1000, [w.seconds]: source.windowMs / 1000 }}
            look={timeline.look}
            mood={timeline.mood}
            turns={turns}
            onTurns={setTurns}
            session={session}
            onSession={setSession}
            onApply={(changes) => setInputs((x) => ({ ...x, ...changes }))}
            onClose={() => setDesigning(false)}
          />
        </Suspense>
      )}

      <div className={designing ? "hidden" : "@container/column flex min-h-0 grow flex-col gap-3.5 overflow-y-auto p-4"}>
        {!source ? (
          <span className="text-ink-2">Drop a long video on the Source lane under the track (a meme, a dance), or right-click a video clip and choose <span className="font-semibold">Motion transfer in windows…</span></span>
        ) : !form || !recipe ? (
          <div className="flex flex-col gap-1.5">
            <div className="text-xs font-semibold">Model</div>
            {models.length ? <Select label="Model" value="" onChange={(id) => onEdit({ recipe: id })} placeholder="Choose the model the clips are made with" options={models.map((r) => ({ value: r.id, label: name(r) }))} /> : <span className="text-xs text-warn-ink">No model that makes a long video window by window is on: turn on SCAIL-2 in Settings › Models.</span>}
          </div>
        ) : formless ? (
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1.5">
              <div className="text-xs font-semibold">Model</div>
              <Select label="Model" value={recipe.id} onChange={(id) => onEdit({ recipe: id })} options={models.map((r) => ({ value: r.id, label: name(r), detail: r.summary }))} />
            </div>
            {sourceChapter.node}
            <span className="text-xs text-ink-2">The prompt, the picture of who goes in and the settings are in the clips' form once they are made: a change there goes to every clip, but the prompt, which each clip keeps its own.</span>
          </div>
        ) : (
          <CardPrompt.Provider value>
            <Form
              key={`source:${form.id}`}
              recipe={form}
              machine={pickedOn?.id}
              status={status}
              stored={inputs}
              onChange={(input, value) => setInputs((x) => ({ ...x, [input]: value }))}
              onClear={(ids) => setInputs((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !ids.includes(k))))}
              made={<Select label="Model" value={recipe.id} onChange={(id) => onEdit({ recipe: id })} options={models.map((r) => ({ value: r.id, label: name(r), detail: r.summary }))} />}
              madeSummary={name(recipe)}
              lead={sourceChapter}
              frameExtra={pictureSpec ? { summary: "", node: <PictureFromFrame timeline={timeline} place={place} clock={clock} current={picture ?? null} onPick={(id) => setInputs((x) => ({ ...x, [pictureSpec.id]: id }))} /> } : undefined}
              helpers={
                <WritingHelp
                  recipe={form}
                  text={written}
                  look={timeline.look}
                  onLook={onLook}
                  onDesigner={() => setDesigning(true)}
                  onInsert={(snippet) => main?.type === "prompt" && setInputs((x) => ({ ...x, [main.id]: appendTo(written, snippet, main.style) }))}
                />
              }
            />
          </CardPrompt.Provider>
        )}
      </div>

      {source && (
        <div className="flex shrink-0 flex-col gap-2 border-t border-line px-3.5 py-3">
          {waitsFor && <span className="text-xs text-warn-ink">{waitsFor}</span>}
          {/* the pick asked for where Make waits for it: the Source card holding it may be scrolled away */}
          {takesPick && !source.pick && !place?.made && !picking && (
            <Button className="h-10 justify-center gap-2 text-sm" onClick={() => onPicking(true)}>
              <Crosshair size={16} aria-hidden />
              Pick on the stage
            </Button>
          )}
          {/* once made, it follows the clips: those with nothing to play are rendered from here, with the timeline's machine
              slice (a "Made" with nothing to press left renders that failed or were cancelled to Render all at the top) */}
          {place?.made ? (
            <span className="flex">
              <Button tone="primary" className={cx("h-11 grow text-sm", several && made.left > 0 && "rounded-r-none!")} disabled={rendering || made.left === 0} onClick={onRender}>
                {rendering ? "Sending…" : made.left > 0 ? `Render ${plural(made.left, "clip")}` : made.queued > 0 ? `Rendering · ${made.queued} in the queue` : "Made · every clip rendered"}
              </Button>
              {made.left > 0 && <RenderOn pickKey={timelineKey(timeline.id)} msOn={() => null} />}
            </span>
          ) : (
            <Button tone="primary" className="h-11 text-sm" disabled={making || !recipe || Boolean(waitsFor) || !windows.length} onClick={() => onMake(!formless)}>
              {/* with a form the clips are rendered as they are made, so the button says Render as every send to the GPU does */}
              {making ? "Making…" : `${formless ? "Make" : "Render"} ${plural(windows.length, "clip")}`}
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * The picture made for the user (pictureMaker.tsx), from the frame of the source the playhead stands on (pick one where the
 * person is seen well), the timeline cast's people offered as who goes in. Reads the clock on its own, to the half second:
 * only it redraws as the source plays, and its frame is not asked for at every tick.
 */
function PictureFromFrame({ timeline, place, clock, current, onPick }: { timeline: Timeline; place: SourcePlace | null; clock: Clock; current: string | null; onPick(id: string): void }) {
  const source = timeline.source!;
  // within the stretch that is made into clips: the playhead on the dimmed rest of the lane gave a frame of a part never
  // animated; read to the half second, so a tick that leaves it there redraws nothing (the stage ticks at every frame)
  const at = useClockAs(clock, (time) => Math.round(Math.max(source.fromMs, Math.min(source.toMs, time - (place?.atMs ?? 0))) / 500) * 500);
  const made = usePictureSets((s) => (s.of[`source:${timeline.id}`]?.jobs.length ?? 0) > 0);
  if (current && !made) return null;
  return (
    <PictureMaker
      keyId={`source:${timeline.id}`}
      video={source.asset}
      atMs={at}
      name={`Picture for ${timeline.name}`}
      folder={timeline.folderId}
      cast={timeline.look?.cast.map((c) => c.id)}
      current={current}
      onPick={onPick}
      frameControl={<span className="text-xs text-ink-3">Move the playhead on the source (play it, or drag it on its lane) to choose another.</span>}
    />
  );
}
