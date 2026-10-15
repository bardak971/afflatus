import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { DesignerSession, Look, RecipeInfo, SourcePatch, Timeline } from "../../api";
import type { DesignerTurn } from "../../designer/types";
import { useQueue, useRecipes, useSetup } from "../../data";
import { timelineKey } from "../../draftMachine";
import { RenderOn } from "../../GenerateOn";
import { severalMachines } from "../../machines";
import { clock as mmss, plural, recipeLabel } from "../../format";
import { useSettled } from "../../hooks";
import { PictureMaker, usePictureSets } from "../../pictureMaker";
import { appendTo } from "../../promptText";
import { Form, mainTextOf } from "../../RecipeForm";
import { CardPrompt } from "../../recipeForm/Part";
import { Select } from "../../Select";
import { Button, cx, Toggle } from "../../ui";
import { WritingHelp } from "../../WritingHelp";
import { useClock, type Clock } from "../clock";
import { ColumnEdge, FoldButton, useColumnWidth } from "../column";
import { windowed, type SourcePlace } from "../track/SourceLane";
import { CloseButton, Slide } from "./parts";

const Designer = lazy(() => import("../../Designer").then((m) => ({ default: m.Designer })));

/**
 * The source lane opened in the column, as a clip's panel: the model's whole form (its cards, the Designer on its prompt)
 * that every window is made with, its driving video being the source's (each window its part); the source's own chapter
 * first (the stretch, the window, scene cuts); and Make N clips at the foot. The stage plays the source meanwhile, and a
 * picture is made from the frame the playhead stands on. Each made clip keeps its own form afterwards.
 */
export function SourcePanel({ timeline, place, recipes, clock, onEdit, onLook, onMake, making, made, onRender, rendering, onClose }: {
  timeline: Timeline;
  place: SourcePlace | null;
  /** The video models of this timeline: those that make a source window by window are offered. */
  recipes: RecipeInfo[];
  /** The timeline's clock: where the stage stands on the source (the track's own time). */
  clock: Clock;
  onEdit(patch: SourcePatch | null): void;
  onLook(look: Look): void;
  onMake(): void;
  making: boolean;
  /** Once made: how many of its clips have nothing to play and wait for no render, and how many are in the queue. */
  made: { left: number; queued: number };
  /** Its clips that have nothing to play sent to render, as Render all sends them (where the timeline's slice says). */
  onRender(): void;
  rendering: boolean;
  onClose(): void;
}) {
  const panelWidth = useColumnWidth();
  const several = severalMachines(useQueue().data).length > 0;
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
  // what is typed, kept here and saved once it stops changing (one step for Undo, not one a key)
  const [inputs, setInputs] = useState<Record<string, unknown>>(source?.inputs ?? {});
  const saved = useRef(JSON.stringify(source?.inputs ?? {}));
  useEffect(() => {
    const now = JSON.stringify(source?.inputs ?? {});
    if (now !== saved.current) {
      saved.current = now;
      setInputs(source?.inputs ?? {});
    }
  }, [source?.inputs]);
  const settled = useSettled(inputs, 600);
  useEffect(() => {
    const now = JSON.stringify(settled);
    if (now === saved.current) return;
    saved.current = now;
    onEdit({ inputs: settled });
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps -- saved when what is typed settles
  const [designing, setDesigning] = useState(false);
  const [turns, setTurns] = useState<DesignerTurn[]>([]);
  const [session, setSession] = useState<DesignerSession | null>(null);
  const status = setup.data?.recipes.find((r) => r.id === recipe?.id);
  const name = (r: RecipeInfo) => recipeLabel(all.data?.families.find((f) => f.id === r.family)?.name, r.title);
  const pictureSpec = recipe?.inputs.find((i) => i.type === "image" && i.role === "source");
  const picture = pictureSpec ? (inputs[pictureSpec.id] as string | undefined) : undefined;
  const windows = place?.windows ?? [];
  const most = w ? Math.floor(((w.shape.most - w.shape.carried) / w.shape.fps) * 10) / 10 : 5;
  const main = form ? mainTextOf(form) : undefined;
  const written = main ? String(inputs[main.id] ?? "") : "";
  // what Make waits for: the Picture of a model that takes one (Motion transfer), the words a model needs (a swap's who to replace)
  const waitsFor = pictureSpec && !picture ? `Choose the ${pictureSpec.label.toLowerCase()} first.` : main && main.type === "prompt" && !main.optional && !written.trim() ? `Write ${main.label.toLowerCase()} first.` : null;

  return (
    <aside data-designer-stays style={{ width: panelWidth }} className="relative flex shrink-0 flex-col border-l border-line bg-panel">
      <ColumnEdge />
      <div className="flex shrink-0 items-start gap-2 border-b border-line px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 grow flex-wrap items-center gap-1.5 pt-0.5">
          <span className="mr-0.5 flex h-6 shrink-0 items-center rounded-[7px] bg-accent-wash px-2 text-xs font-bold text-accent uppercase">Source</span>
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
            {models.length ? <Select label="Model" value="" onChange={(id) => onEdit({ recipe: id })} placeholder="Choose the model the clips are made with" options={models.map((r) => ({ value: r.id, label: name(r) }))} /> : <span className="text-xs text-warn-ink">No model that makes a long video window by window is on: turn on SCAIL-2 or Wan Animate 2 in Settings › Models.</span>}
          </div>
        ) : (
          <CardPrompt.Provider value>
            <Form
              key={`source:${form.id}`}
              recipe={form}
              status={status}
              stored={inputs}
              onChange={(input, value) => setInputs((x) => ({ ...x, [input]: value }))}
              onClear={(ids) => setInputs((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !ids.includes(k))))}
              made={<Select label="Model" value={recipe.id} onChange={(id) => onEdit({ recipe: id })} options={models.map((r) => ({ value: r.id, label: name(r), detail: r.summary }))} />}
              madeSummary={name(recipe)}
              lead={{
                id: "source",
                title: "Source",
                help: "The stretch of the video made into clips, one a window, each carrying on from the one before. Drag the source on its lane to choose where Motion transfer starts, its right end where it stops; or split it at the playhead (right-click the lane).",
                summary: `${mmss(source.fromMs, { decimals: 1 })}–${mmss(source.toMs, { decimals: 1 })} · ${windows.length} ${windows.length === 1 ? "clip" : "clips"} of ${(Math.min(source.windowMs, most * 1000) / 1000).toFixed(1)} s`,
                node: (
                  <div className="flex flex-col gap-3">
                    <Slide label="Window" value={Math.min(source.windowMs, most * 1000)} min={1000} max={most * 1000} step={100} show={(ms) => `${(ms / 1000).toFixed(1)} s`} onCommit={(windowMs) => onEdit({ windowMs })} />
                    <Toggle on={source.snap} onChange={(snap) => onEdit({ snap })} label="Cut at scene changes" note={source.snap ? "a window ends at a cut in the source; the next one opens a new shot" : "windows of the same length, end to end"} />
                    <span className="text-xs text-ink-2">
                      {place?.made
                        ? "Made: the clips above carry its parts (outlined on the lane)."
                        : `${windows.map((x, k) => `${k + 1}: ${mmss(x.fromMs, { decimals: 1 })}–${mmss(x.toMs, { decimals: 1 })}`).join(" · ")}. Each carries on from the one before (its last frames), with this form and one seed; ${place?.replaces ? "they take the place of the clip the stretch was taken from" : "they go after the last clip"}, dashed on the track.`}
                    </span>
                  </div>
                ),
              }}
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
            <Button tone="primary" className="h-11 text-sm" disabled={making || !recipe || Boolean(waitsFor) || !windows.length} onClick={onMake}>
              {making ? "Making…" : `Make ${plural(windows.length, "clip")}`}
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
  const time = useClock(clock);
  const made = usePictureSets((s) => (s.of[`source:${timeline.id}`]?.jobs.length ?? 0) > 0);
  const source = timeline.source!;
  if (current && !made) return null;
  // within the stretch that is made into clips: the playhead on the dimmed rest of the lane gave a frame of a part never animated
  const at = Math.round(Math.max(source.fromMs, Math.min(source.toMs, time - (place?.atMs ?? 0))) / 500) * 500;
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
