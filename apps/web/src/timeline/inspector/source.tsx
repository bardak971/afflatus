import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sparkles, Wand2 } from "lucide-react";
import { fileUrl, type DesignerSession, type RecipeInfo, type SourcePatch, type Timeline } from "../../api";
import type { DesignerTurn } from "../../designer/types";
import { useEntities, useRecipes } from "../../data";
import { clock } from "../../format";
import { useMakeSourcePicture } from "../../motionPicture";
import { PictureField } from "../../PictureField";
import { RangeSlider } from "../../RangeSlider";
import { useSayFailed } from "../../sayFailed";
import { Button, Help, SectionTitle, Segmented, Toggle } from "../../ui";
import { ColumnEdge, FoldButton, useColumnWidth } from "../column";
import { plannedWindows, windowed } from "../track/SourceLane";
import { CloseButton, Slide } from "./parts";

const Designer = lazy(() => import("../../Designer").then((m) => ({ default: m.Designer })));

/**
 * The source lane opened in the column: the long video, the stretch of it made into clips, the model and its window, the
 * picture and the prompt every window shares, and Make N clips (each window a clip carrying on from the one before, sent to
 * render in order). The rest of a window's form (steps, its own advanced settings) is the clip's own afterwards.
 */
export function SourcePanel({ timeline, recipes, onEdit, onMake, making, onClose }: {
  timeline: Timeline;
  /** The video models of this timeline: those that make a source window by window are offered. */
  recipes: RecipeInfo[];
  onEdit(patch: SourcePatch | null): void;
  onMake(): void;
  making: boolean;
  onClose(): void;
}) {
  const panelWidth = useColumnWidth();
  const families = useRecipes().data?.families ?? [];
  const entities = useEntities();
  const makePicture = useMakeSourcePicture();
  const failed = useSayFailed({ id: "source-picture" });
  const source = timeline.source;
  const models = recipes.filter((r) => windowed(r));
  const recipe = models.find((r) => r.id === source?.recipe);
  // a source without a model yet takes the first that can make it
  useEffect(() => {
    if (source && !recipe && models[0]) onEdit({ recipe: models[0].id });
  }, [source?.asset, recipe, models[0]?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- once a source has no model
  // the prompt typed here, saved when it is left
  const [prompt, setPrompt] = useState(source?.prompt ?? "");
  useEffect(() => setPrompt(source?.prompt ?? ""), [source?.prompt]);
  const first = timeline.look?.cast[0];
  const person = first ? entities.data?.items.find((e) => e.id === first.id && e.kind === "person") : undefined;
  const face = person && person.kind === "person" ? person.def.pictures[0] ?? null : null;
  // the source played here: the frame it stands on is where a picture is made from, and where the stretch can be set
  const player = useRef<HTMLVideoElement>(null);
  const [atMs, setAtMs] = useState(source?.fromMs ?? 0);
  const picture = useMutation({
    mutationFn: () => makePicture(source!.asset, atMs, face, `Picture for ${timeline.name}`),
    onError: failed("The picture could not be started"),
  });
  // the designer writes the prompt every window shares, from the picture (the conversation lasts while the panel is open)
  const [designing, setDesigning] = useState(false);
  const [turns, setTurns] = useState<DesignerTurn[]>([]);
  const [session, setSession] = useState<DesignerSession | null>(null);

  const w = windowed(recipe);
  const windows = source && recipe ? plannedWindows(source, recipe) : [];
  const most = w ? Math.floor(((w.shape.most - w.shape.carried) / w.shape.fps) * 10) / 10 : 5;
  const length = source?.video.durationMs ?? 0;
  const name = (r: RecipeInfo) => families.find((f) => f.id === r.family)?.name ?? r.title;
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

      <div className="@container/column flex min-h-0 grow flex-col gap-4 overflow-y-auto p-4">
        {!source ? (
          <span className="text-ink-2">Drop a long video on the Source lane under the track (a meme, a dance), or split a video clip where Motion transfer starts and choose <span className="font-semibold">Motion transfer in windows…</span> on the part after.</span>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <video
                key={source.video.id}
                ref={player}
                src={fileUrl(source.video.id)}
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={(e) => (e.currentTarget.currentTime = source.fromMs / 1000)}
                onTimeUpdate={(e) => setAtMs(Math.round(e.currentTarget.currentTime * 1000))}
                onSeeked={(e) => setAtMs(Math.round(e.currentTarget.currentTime * 1000))}
                className="max-h-72 w-full rounded-lg bg-black object-contain"
              />
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 font-mono text-xs text-ink-2">{clock(atMs, { decimals: 1 })}</span>
                <Button size="sm" onClick={() => onEdit({ fromMs: Math.min(atMs, source.toMs - 1000) })} data-tip="The stretch made into clips starts at this frame">Start here</Button>
                <Button size="sm" onClick={() => onEdit({ toMs: Math.max(atMs, source.fromMs + 1000) })} data-tip="The stretch made into clips ends at this frame">End here</Button>
              </span>
              <span className="text-xs text-ink-2">
                {clock(length)} long. Its stretch from <span className="font-semibold text-ink">{clock(source.fromMs, { decimals: 1 })}</span> to <span className="font-semibold text-ink">{clock(source.toMs, { decimals: 1 })}</span> is made into clips; the rest stays as it is.
              </span>
            </div>
            {length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5"><SectionTitle>Stretch</SectionTitle><Help title="Stretch" text="The part of the source made into clips. What comes before it can stay the source itself: split the video clip there, and make the clips from the part after." /></span>
                <RangeSlider label="Stretch of the source" from={source.fromMs} to={source.toMs} min={0} max={length} step={100} gap={1000} format={(v) => clock(v, { decimals: 1 })} onChange={() => {}} onCommit={(fromMs, toMs) => onEdit({ fromMs, toMs })} />
              </div>
            )}

            <div className="flex flex-col gap-2">
              <SectionTitle>Model</SectionTitle>
              {models.length ? (
                <Segmented label="Model" value={recipe?.id ?? ""} onChange={(id) => onEdit({ recipe: id })} options={models.map((r) => ({ value: r.id, label: name(r) }))} />
              ) : (
                <span className="text-xs text-warn-ink">No model that makes a long video window by window is on: turn on SCAIL-2 or Wan Animate 2 in Settings › Models.</span>
              )}
              <Slide label="Window" value={Math.min(source.windowMs, most * 1000)} min={1000} max={most * 1000} step={100} show={(ms) => `${(ms / 1000).toFixed(1)} s`} onCommit={(windowMs) => onEdit({ windowMs })} />
              <Toggle on={source.snap} onChange={(snap) => onEdit({ snap })} label="Cut at scene changes" note={source.snap ? "a window ends at a cut in the source; the next one opens a new shot" : "windows of the same length, end to end"} />
            </div>

            <div className="flex flex-col gap-2">
              <PictureField label="Picture" note="what moves, in every window: the same picture keeps the person the same from clip to clip" optional={false} value={source.picture} onChange={(id) => onEdit({ picture: id ?? null })} />
              {!source.picture && (
                <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-line-strong px-3 py-2.5">
                  <Button size="sm" className="self-start" disabled={picture.isPending} onClick={() => picture.mutate()}><Wand2 size={14} /> Make it from this frame…</Button>
                  <span className="text-xs text-ink-2">
                    The frame the player above stands on ({clock(atMs, { decimals: 1 })}: pick one where the person is seen well), {person ? <>with {person.name} (the timeline's cast) put in,</> : "opened on its References (drop who goes in there),"} in Qwen Image 2.1 · Edit: 3 pictures, pick one and drop it here.
                  </span>
                </div>
              )}
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="flex items-center justify-between gap-2">
                <SectionTitle>Prompt</SectionTitle>
                {recipe && (
                  <Button size="sm" onClick={(e) => { e.preventDefault(); setDesigning((d) => !d); }} data-tip="The designer writes it with you, from the picture">
                    <Sparkles size={13} /> Designer
                  </Button>
                )}
              </span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onBlur={() => prompt !== source.prompt && onEdit({ prompt })}
                rows={3}
                placeholder="What the picture shows, in sentences: optional, it helps the model keep what is there."
                className="resize-y rounded-lg border border-line bg-raised px-3 py-2 text-sm"
              />
            </label>
            {designing && recipe && (
              <Suspense fallback={null}>
                <Designer
                  side="inline"
                  draftKey={`source:${timeline.id}`}
                  recipe={recipe}
                  // the form one window would have: the picture it reads, the prompt it writes, the source's part
                  values={{ picture: source.picture ?? undefined, prompt, driving: { asset: source.asset }, drivingStart: source.fromMs / 1000, drivingSeconds: source.windowMs / 1000 }}
                  look={timeline.look}
                  mood={timeline.mood}
                  turns={turns}
                  onTurns={setTurns}
                  session={session}
                  onSession={setSession}
                  onApply={(changes) => {
                    const next = typeof changes.prompt === "string" ? changes.prompt : prompt;
                    setPrompt(next);
                    onEdit({ prompt: next });
                  }}
                  onClose={() => setDesigning(false)}
                />
              </Suspense>
            )}

            <div className="flex flex-col gap-1">
              <SectionTitle>{windows.length} {windows.length === 1 ? "clip" : "clips"}</SectionTitle>
              <span className="text-xs text-ink-2">
                {windows.map((x, k) => `${k + 1}: ${clock(x.fromMs, { decimals: 1 })}–${clock(x.toMs, { decimals: 1 })}`).join(" · ")}
              </span>
              <span className="text-xs text-ink-2">Each carries on from the one before (its last frames), the same picture and seed in all. {source.clip ? "They take the place of the clip the stretch was taken from." : "They go after the last clip."}</span>
            </div>
          </>
        )}
      </div>

      {source && (
        <div className="flex shrink-0 flex-col gap-2 border-t border-line px-3.5 py-3">
          {!source.picture && <span className="text-xs text-warn-ink">Choose the picture first.</span>}
          <Button tone="primary" className="h-11 text-sm" disabled={making || !recipe || !source.picture || !windows.length} onClick={onMake}>
            {making ? "Making…" : `Make ${windows.length} ${windows.length === 1 ? "clip" : "clips"}`}
          </Button>
          <Button size="sm" className="self-start" onClick={() => onEdit(null)}>Remove the source</Button>
        </div>
      )}
    </aside>
  );
}
