import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Music } from "lucide-react";
import { api, thumbUrl, type Asset, type Clip, type MachineState, type RecipeInfo, type Take, type Timeline } from "../api";
import { useQueue, useRecipes, useSetup } from "../data";
import { timelineKey } from "../draftMachine";
import { GenerateOn, shortName, usePickedMachine } from "../GenerateOn";
import { severalMachines } from "../machines";
import { FormModel } from "../ModelLoad";
import { phaseLabel, timeLeft } from "../format";
import { Picker } from "../PictureField";
import { Bar, Button, cx, ErrorNote, Help, SectionTitle, Segmented, Toggle } from "../ui";
import { Keys } from "../Keys";
import { ColumnEdge, useColumnWidth } from "./column";
import { otherShape, pinInputs, pinMirrors, roomOf, shapeOf, type ShownPatch } from "./model";
import { useRunningOf } from "./useRunning";
import { SHOWS } from "./attention";
import { Estimate } from "./estimate";
import { ClipForm } from "./inspector/form";
import { ClipHead } from "./inspector/head";
import { LookTable } from "./inspector/look";
import { Slide } from "./inspector/parts";
import { Duration, PinnedFrames, TakeList } from "./inspector/takes";
import { queryKeys } from "../queryKeys";

/** The selected clip: how it starts, its takes, its sound, its pictures and its form. */
/** Where how many takes a render makes is remembered, per browser. */
const TAKES_KEY = "afflatus.timeline.takes";

export function Inspector({ timeline, clip, index, recipes, stored, whole, why, takesMs, takesOn, busy, error, onInputs, onRecipe, onPatch, onRender, onMenu, onRemoveTake, onStop, onPreview, onDesigner, designer, writing, writeError, onWriteBetween, onClose, onSelectClip, onOpen }: {
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
  /** About how long a render of it takes, in ms, on the machine picked for the timeline (else Auto); null when nothing like it was rendered yet. */
  takesMs: number | null;
  /** The same on a machine (null: Auto), for the machine list beside New take. */
  takesOn(m: MachineState | null): number | null;
  busy: boolean;
  error: string | null;
  onInputs(next: Record<string, unknown>): void;
  onRecipe(id: string): void;
  onPatch(patch: ShownPatch): void;
  /** Render it: `count` takes at once (the first with the form's seed, the others with a fresh one each). Where it ends is the clip's own fitNext. */
  onRender(count: number): void;
  /** The clip's own menu (its right-click menu on the track), under the head's ··· button: Remove clip is there, with its Del. */
  onMenu(e: { preventDefault(): void; clientX: number; clientY: number; currentTarget?: EventTarget | null }): void;
  /** The viewer, on a picture (a pinned frame's menu: Open). */
  onOpen?(asset: Asset): void;
  onRemoveTake(id: string): void;
  /** Stop the render of this clip that is under way, or take it out of the queue. */
  onStop(): void;
  /** Make the clip end where it begins: on its opening picture, or on the first frame of its take. */
  /** A take is hovered: show it in the player without choosing it. */
  onPreview(take: Take | null): void;
  /** Open the designer for this clip, or close it. */
  onDesigner(): void;
  /** The designer, open: shown in place of the clip's form, which stays as it was under it. */
  designer?: ReactNode;
  /** The designer is writing what happens between the clips around (a clip put between two others). */
  writing?: boolean;
  writeError?: string | null;
  /** Ask the designer to write it (again). */
  onWriteBetween?(): void;
  /** Back to the timeline's own panel (its name, music, cast, where renders land, export): also Escape. */
  onClose?(): void;
  /** Open another clip in the panel (the one before or after, the one it extends); left out, those are not offered. */
  onSelectClip?(id: string): void;
}) {
  const panelWidth = useColumnWidth();
  const all = useRecipes();
  const setup = useSetup();
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
  const takesTotal = takesMs === null ? null : takesMs * count;
  const takesTotalOn = (m: MachineState | null) => {
    const one = takesOn(m);
    return one === null ? null : one * count;
  };
  // with several ComfyUIs: the machine picked for this timeline, said on the button (takesMs is already its own figure)
  const several = severalMachines(useQueue().data).length > 0;
  const picked = usePickedMachine(timelineKey(timeline.id));
  // what a render of it is called, the same in the broken-join banner and the foot: a clip with a take gets a new take
  const renderWords = count > 1 ? `Render ${count} takes` : clip.take ? "New take" : "Render this clip";
  const [picking, setPicking] = useState<"sound" | "start" | "end" | "mid" | null>(null);
  const recipe = recipes.find((r) => r.id === clip.recipe) ?? all.data?.recipes.find((r) => r.id === clip.recipe);
  const status = setup.data?.recipes.find((r) => r.id === recipe?.id);
  const before = index > 0 ? timeline.clips[index - 1] : undefined;
  const after = timeline.clips[index + 1];
  const still = clip.kind === "still";
  const carries = Boolean(before) && clip.joined === "continue" && !still;
  const pins = pinInputs(recipe);
  const opens = !carries && pins.start && typeof stored[pins.start] === "string" ? (stored[pins.start] as string) : null;
  const ends = pins.end && typeof stored[pins.end] === "string" ? (stored[pins.end] as string) : null;
  const through = pins.mid && typeof stored[pins.mid] === "string" ? (stored[pins.mid] as string) : null;
  const midSpec = recipe?.inputs.find((i) => i.id === pins.midAt);
  // what the timeline fills in itself is not asked for in the form: the clips it joins onto, and its pinned pictures (shown above it)
  const form = useMemo(
    () => (recipe ? { ...recipe, inputs: recipe.inputs.filter((i) => i.type !== "clip" && !(i.type === "image" && (i.role === "start" || i.role === "end" || i.role === "mid")) && i.id !== pins.midAt) } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pins come from the recipe
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
    ? { mine: shapes[shapeOf(shown.width, shown.height)], video: shapes[shapeOf(timeline.width, timeline.height)] }
    : null;
  const hasOwn = Boolean(take?.asset.hasSound);
  // how smoothly each take meets the clips around: worked out once there is a choice to make
  const joins = useQuery({
    queryKey: queryKeys.joins.around(clip, before, after),
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
  const takesHelp = clip.takes.length > 1 ? `Hover a take to preview it, click to make it play.${joins.data ? ` The join figures say how much the picture jumps at In and at Out (×1 = like the clip's own motion; past ×${SHOWS} the join shows); the smoothest is marked.` : joins.isFetching ? " Measuring the joins…" : ""}` : "Each render adds a take; the one you pick plays.";
  const durationInner = still || take ? <Duration clip={clip} take={take} room={room} rendered={Boolean(recipe)} onPatch={onPatch} /> : null;
  const lookInner = take?.measure && !still ? <LookTable timeline={timeline} index={index} take={take} onSelectClip={onSelectClip} /> : null;
  const pinnedInner = recipe && !still && (pins.start || pins.end) ? <PinnedFrames stored={stored} pins={pins} frames={{ opens, ends, through, loops, carries }} midDefault={midSpec?.type === "number" ? midSpec.default : 2.5} mirrors={pinMirrors(clip, recipe, stored, carries)} pictures={clip.pictures} onInputs={onInputs} onPick={setPicking} onMirror={(input, on) => onPatch({ pinMirror: { [input]: on } })} onOpen={onOpen} /> : null;
  const pinHelp = `${carries && pins.start ? `It extends clip ${index}, so it needs no first frame. ` : ""}Or drop an image on the clip: near its start for the first frame, near its end for the last frame${pins.mid ? ", in the middle for a keyframe" : ""}.${take ? " A pinned frame counts from the next take." : ""}`;
  const playing = take ? clip.takes.findIndex((t) => t.id === take.id) + 1 : 0;
  const takesLead = inForm && (takesInner || durationInner) ? {
    id: "takes",
    title: "Takes",
    // for the part's ?, once the form's lead passes it on (the rows' tips say it meanwhile)
    help: takesHelp,
    summary: take ? `take ${playing} of ${clip.takes.length} plays · ${(clip.lengthMs / 1000).toFixed(1)} s${take.trimStartMs > 0 || take.trimEndMs > 0 ? " · trimmed" : ""}` : "none yet",
    node: (
      <div className="flex flex-col gap-3">
        {takesInner}
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
        <span className="flex items-center gap-1.5 font-semibold">Pinned frames<Help text={pinHelp} /></span>
        {pinnedInner}
      </div>
    ),
  } : undefined;

  return (
    <aside data-designer-stays style={{ width: panelWidth }} className="relative flex shrink-0 flex-col border-l border-line bg-panel">
      <ColumnEdge />
      <ClipHead clip={clip} index={index} shown={shown} before={before} after={after} carries={carries} imported={!still && !recipe && Boolean(take)} misfit={misfit} onSelectClip={onSelectClip} onMenu={onMenu} onClose={onClose} />

      {designer}
      {/* a container: the form's rows lay out by the column's width (FieldRow), which can go down to 320 px */}
      <div className={cx("@container/column flex min-h-0 grow flex-col gap-3.5 overflow-y-auto p-4", designer ? "hidden" : "")}>
        {still && clip.still && (
          <>
            <img src={thumbUrl(clip.still.id)} alt={clip.still.name} className="max-h-56 self-start rounded-lg" />
            <span><Button onClick={() => onPatch({ animate: true })}>Image to video (i2v)</Button></span>
          </>
        )}

        {/* how it joins the clip before is on the track: the dot between them switches cut and extend; only a broken join is said here */}
        {before && !still && clip.join === "stale" && (
          <div className="flex flex-col gap-2 rounded-lg border border-warn bg-warn-wash p-3">
            <span className="font-semibold text-warn-ink">This clip no longer follows clip {index}</span>
            <span className="text-xs text-ink-2">Clip {index} changed after this one was rendered, so {before.kind === "still" ? "its first frame is no longer that image" : "the motion jumps between them"}.</span>
            <span className="flex flex-wrap gap-1.5">
              {recipe && <Button size="sm" tone="danger" disabled={Boolean(why) || busy || Boolean(clip.job)} onClick={() => onRender(count)}>{renderWords}<Estimate ms={takesTotal} /></Button>}
              <Button size="sm" onClick={() => onPatch({ joined: "cut" })}>Keep as a cut</Button>
            </span>
          </div>
        )}

        {clip.failed && !clip.job && <ErrorNote>The last render failed: {clip.failed}</ErrorNote>}

        {misfit && <Toggle on={clip.fill} onChange={(fill) => onPatch({ fill })} label="Fill frame (crop)" note={clip.fill ? "its edges are cropped" : "letterboxed: shown whole, with bars"} />}

        {!inForm && takesInner && <div className="flex flex-col gap-2"><span className="flex items-center gap-1.5"><SectionTitle>Takes</SectionTitle><Help title="Takes" text={takesHelp} /></span>{takesInner}</div>}
        {!inForm && durationInner}
        {!inForm && lookInner}
        {!inForm && pinnedInner && <div className="flex flex-col gap-2"><SectionTitle>Pinned frames</SectionTitle>{pinnedInner}</div>}

        {!still && (
          <ClipForm
            timeline={timeline} clip={clip} index={index} recipes={recipes} recipe={recipe} form={form} status={status} stored={stored} whole={whole}
            before={before} after={after} take={take} opens={opens} ends={ends} carries={carries} lead={takesLead} frameExtra={framesExtra}
            writing={writing} writeError={writeError} onRecipe={onRecipe} onInputs={onInputs} onPatch={onPatch} onDesigner={onDesigner} onWriteBetween={onWriteBetween}
          />
        )}
        {(take || still) && (
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-1.5"><SectionTitle>Audio</SectionTitle>{!still && !hasOwn && heard !== "file" && <Help title="No audio of its own" text="This clip has no audio of its own. Drop an audio file on it, or choose one." />}</span>
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
          </div>
        )}

      </div>

      {recipe && !still && (
        <div className="flex shrink-0 flex-col gap-2.5 border-t border-line px-3.5 py-3">
          {error && <ErrorNote>{error}</ErrorNote>}
          {why && <div className="text-xs text-warn-ink">{why} {why.includes("ComfyUI") || why.includes("model") ? <Link href={why.includes("ComfyUI") ? "/settings" : "/settings/models"} className="font-semibold underline">Open Settings</Link> : null}</div>}
          {/* a pinned last frame wins over the landing (the server skips it): shown off, the stored choice kept for when the pin goes */}
          {canFit && (
            <div className="flex flex-col gap-1">
              <Toggle on={clip.fitNext && !ends} onChange={(fitNext) => onPatch({ fitNext })} disabled={Boolean(ends)} label={`End where clip ${index + 2} begins`} note={ends ? "off: this clip's own last frame is pinned" : "so that clip need not be redone"} />
            </div>
          )}
          {!clip.job && (
            <div className="flex items-center gap-2.5">
              <span className="grow font-semibold">Takes at once</span>
              <Segmented<"1" | "2" | "3"> label="Takes at once" size="sm" oneLine value={String(count) as "1" | "2" | "3"} onChange={(v) => pickCount(Number(v) as 1 | 2 | 3)} options={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }]} className="[&>button]:w-[34px] [&>button]:px-0" />
            </div>
          )}
          {whole && !clip.job && <FormModel recipe={recipe} input={whole} look={clip.look ?? timeline.look} />}
          {clip.job ? (
            <RenderProgress clip={clip.id} onStop={onStop} />
          ) : (
            <div className="flex">
              <Button tone="primary" className={cx("h-11 min-w-0 grow text-sm", several && "rounded-r-none")} disabled={Boolean(why) || busy} onClick={() => onRender(count)} data-tip={count > 1 ? "The first take keeps the form's seed; the others get a fresh seed each. Pick the best in Takes." : undefined}>
                {busy ? "Sending…" : <>{picked ? `${renderWords} on ${shortName(picked)}` : renderWords}<Estimate ms={takesTotal} /></>}
                {/* Ctrl+Enter renders one take: said only when that is what the button does */}
                {!busy && count === 1 && <Keys keys="Ctrl+Enter" size="sm" />}
              </Button>
              {/* with several ComfyUIs, the machine this timeline's clips render on (GenerateOn.tsx) */}
              {several && recipe && whole && <GenerateOn recipe={recipe} pickKey={timelineKey(timeline.id)} whole={whole} look={clip.look ?? timeline.look} msOn={takesTotalOn} of="timeline" />}
            </div>
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

/** The clip's render under way, or its place in the queue: read from the queue on its own, so that only this draws again at every step. */
function RenderProgress({ clip, onStop }: { clip: string; onStop(): void }) {
  const running = useRunningOf(clip);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-semibold">{running ? phaseLabel(running.phase) : "Queued"}</span>
        <span className="text-xs text-ink-2">{running?.steps ? `step ${running.step} of ${running.steps}` : ""}{running?.eta ? ` · ${timeLeft(running.eta)}` : ""}</span>
      </div>
      <Bar value={(running?.progress ?? 0) * 100} steps={running?.steps} loading={Boolean(running) && !running?.progress} />
      <Button size="sm" className="self-start" onClick={onStop} data-tip={running ? "Stop this render. Nothing is added; the clip keeps the takes it has." : "Remove it from the queue."}>
        {running ? "Stop render" : "Remove from queue"}
      </Button>
    </div>
  );
}

