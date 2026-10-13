import { lazy, Suspense, type RefObject } from "react";
import { useKeysHere } from "../keys/here";
import type { Range } from "../Trim";
import { fileUrl, type Asset } from "../api";
import { DRAG_HAS_SOUND, DRAG_TYPE, dragKind } from "../dragging";
import type { ViewerActions } from "./useViewerActions";
import { AudioPlayer } from "../AudioPlayer";
import { VideoPlayer } from "../VideoPlayer";

// Trim is a chunk of its own: fetched the first time a video is trimmed
const Trim = lazy(() => import("../Trim").then((m) => ({ default: m.Trim })));
const RangeFrames = lazy(() => import("../Trim").then((m) => ({ default: m.RangeFrames })));
// and a sound's, the first time a sound is trimmed
const AudioTrim = lazy(() => import("../trim/AudioTrim").then((m) => ({ default: m.AudioTrim })));

/** The item shown large, dragged like a tile: onto a folder, a form's picture field, a timeline. */
const dragOf = (a: Asset) => (e: React.DragEvent) => {
  e.dataTransfer.setData(DRAG_TYPE, a.id);
  e.dataTransfer.setData(dragKind(a.kind), a.id);
  if (a.kind === "video" && a.hasSound) e.dataTransfer.setData(DRAG_HAS_SOUND, a.id);
  e.dataTransfer.effectAllowed = "copyMove";
};

/**
 * The item itself, large: a picture, a video with Trim under it, or a sound (in Trim: over its waveform). In place, the picture is a
 * button that opens the details; over the screen, a click beside the item closes the viewer.
 */
export function ViewerMedia({ acts, player, trim, onTrim: setTrim, trimRange, onTrimRange: setTrimRange, onMenu, overlay, onDetails, onClose }: {
  acts: ViewerActions;
  player: RefObject<HTMLVideoElement | null>;
  trim: boolean;
  onTrim(trim: boolean): void;
  trimRange: Range | null;
  onTrimRange(range: Range | null): void;
  /** A right-click on the picture, the video or the sound: the item's menu. */
  onMenu(e: React.MouseEvent): void;
  /** Over the screen rather than in place. */
  overlay?: boolean;
  /** In place: the picture opens it over the screen, with everything about it. */
  onDetails?(): void;
  /** Over the screen: a click beside the item. */
  onClose?(): void;
}) {
  // the keys sheet's "Here now": the viewer's keys for this kind of item, and Trim's while it is open
  useKeysHere("viewer", true, { kind: acts.a.kind, over: overlay });
  useKeysHere("trim", acts.a.kind === "video" && trim, { over: overlay });
  const { a, g, recipe, scenes, everyScene, between, extendHere, opener, carrier, cutRange } = acts;
  const mainText = recipe?.inputs.find((i) => i.type === "prompt")?.id ?? "prompt";
  const prompt = typeof g?.inputs[mainText] === "string" ? (g.inputs[mainText] as string) : "";
  return (
    <div className={overlay ? "flex min-w-0 grow flex-col items-center justify-center gap-3 p-6" : "flex min-h-0 grow flex-col items-center justify-center gap-2"} onClick={overlay ? onClose : undefined}>
      {a.kind === "image" && (overlay
        ? <img key={a.id} src={fileUrl(a.id)} alt={prompt || "Image"} draggable onDragStart={dragOf(a)} onContextMenu={onMenu} className="max-h-full max-w-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
        : (
          <button type="button" onClick={onDetails} aria-label="Details: generation parameters, lineage and every action" data-tip="Details: generation parameters, lineage and every action" className="flex h-full max-w-full items-center justify-center">
            <img key={a.id} src={fileUrl(a.id)} alt={prompt || "Image"} draggable onDragStart={dragOf(a)} onContextMenu={onMenu} className="max-h-full max-w-full rounded-lg object-contain" />
          </button>
        ))}
      {a.kind === "video" && (
        <div className="flex min-h-0 w-full flex-1 items-center justify-center gap-3" onClick={overlay ? onClose : undefined}>
          <VideoPlayer
            asset={a.id}
            sound={a.hasSound}
            lengthMs={a.durationMs}
            video={player}
            controls={!trim}
            className="h-full max-h-full w-full justify-center"
            videoProps={{ draggable: true, onDragStart: dragOf(a), onContextMenu: onMenu }}
            onVideoClick={overlay ? (e) => e.stopPropagation() : undefined}
          />
          {trim && trimRange && <Suspense fallback={null}><RangeFrames asset={a} range={trimRange} /></Suspense>}
        </div>
      )}
      {a.kind === "audio" && (
        <div className="flex w-full justify-center" onContextMenu={onMenu}>
          {trim ? (
            <Suspense fallback={null}>
              <AudioTrim key={a.id} asset={a} busy={cutRange.isPending} onCut={(range, action, even) => cutRange.mutate({ range, action, crf: 10, even })} onClose={() => setTrim(false)} />
            </Suspense>
          ) : (
            <AudioPlayer key={a.id} asset={a.id} name={a.name || "Audio"} className="w-full max-w-[640px]" onClick={overlay ? (e) => e.stopPropagation() : undefined} />
          )}
        </div>
      )}
      {a.kind === "video" && trim && (
        <Suspense fallback={null}>
        <Trim
          key={a.id}
          asset={a}
          player={player}
          busy={cutRange.isPending || between.isPending || extendHere.isPending}
          onCopy={(range, crf) => cutRange.mutate({ range, action: "copy", crf })}
          onSplit={(range, crf) => cutRange.mutate({ range, action: "split", crf })}
          onRemove={(range, crf) => cutRange.mutate({ range, action: "remove", crf })}
          onSlow={(range, factor) => cutRange.mutate({ range, action: "slow", crf: 16, factor })}
          onBetween={opener ? (range) => between.mutate(range) : undefined}
          onExtendHere={carrier || opener ? (atMs) => extendHere.mutate(atMs) : undefined}
          onRange={setTrimRange}
          scenes={scenes.data?.cuts}
          onEveryScene={(cuts, crf) => everyScene.mutate({ cuts, crf })}
          onClose={() => setTrim(false)}
        />
        </Suspense>
      )}
    </div>
  );
}
