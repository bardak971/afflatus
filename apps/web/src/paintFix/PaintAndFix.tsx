import { useMemo, useRef, useState, type ReactNode } from "react";
import { fileUrl } from "../api";
import { useKeysHere } from "../keys/here";
import { padded } from "../stageLayer/frame";
import { ClickOptions, DetectOptions, FrameOptions, LayerStrip, MaskOptions, WandOptions } from "../stageLayer/LayerStrip";
import { LayerToolbar } from "../stageLayer/LayerToolbar";
import type { Rect } from "../stageLayer/raster";
import { StageLayer, useLayerKeys } from "../stageLayer/StageLayer";
import { HAND_TOOL, type LayerTool, type ToolbarItem } from "../stageLayer/tools";
import { useClickTool, useDetectTool, useWandTool } from "../stageLayer/useFindTools";
import { useFrameTool, type FrameSides } from "../stageLayer/useFrameTool";
import { useMaskLayer } from "../stageLayer/useMaskLayer";
import { ErrorNote } from "../ui";
import type { ViewerActions } from "../viewer/useViewerActions";
import { ZoomPicture } from "../viewer/ZoomPicture";
import { FixBar } from "./FixBar";
import { findOn } from "./findOn";
import { useFixJob } from "./useFixJob";
import type { StageMode } from "./useStageMode";

/** What the mask chip says of what is painted: nothing (null), or its size and whether its edge is soft. */
export const maskSaid = (area: Rect | null, soft: boolean): string | null => (area ? `${Math.round(area.w)}×${Math.round(area.h)}${soft ? ", soft" : ""}` : null);

/** What the frame chip says of what the frame adds: nothing (null), or each side added ("+192 left · +128 top"). */
export function frameSaid(s: FrameSides): string | null {
  const parts = ([["padLeft", "left"], ["padTop", "top"], ["padRight", "right"], ["padBottom", "bottom"]] as const).flatMap(([k, w]) => (s[k] > 0 ? [`+${s[k]} ${w}`] : []));
  return parts.length ? parts.join(" · ") : null;
}

/** How far the mask is grown before the fix when nothing else was asked (the mock's +8 px). */
const GROW = 8;

/**
 * Paint and fix (card #274): Inpaint and Outpaint on the Stage itself, no draft. The picture large with the drawing layer
 * over it (stageLayer/), the tools on its left edge (the mask's, click to mask C and the detectors D over the server's
 * find-mask jobs, the colour wand W, the outpaint frame R), the active tool's options above it, the versions strip under
 * it, then the bar. The bar fixes the painted part, or outpaints once the frame is dragged out; either comes back as
 * versions of the picture. The mask stays while the versions are flipped through (ViewerMedia keys this by the stack).
 */
export function PaintAndFix({ acts, mode, strip, overlay }: {
  acts: ViewerActions;
  /** Outpaint (R) starts on the frame; Inpaint (I) on the brush. */
  mode: StageMode;
  /** The versions strip (VersionStrip), drawn between the picture and the bar. */
  strip: ReactNode;
  overlay?: boolean;
}) {
  const { a } = acts;
  useKeysHere("paint", true, { over: overlay });
  const natural = useMemo(() => (a.width && a.height ? { w: a.width, h: a.height } : null), [a.width, a.height]);
  const mask = useMaskLayer({ natural });
  const { tool: inpaint, fix, fullForm, out, outpaint, outForm } = useFixJob(acts);
  const [toolId, setToolId] = useState(mode === "outpaint" && out ? "frame" : "brush");
  // the finds run on the picture shown (a version is a picture of its own)
  const find = useMemo(() => findOn(a.id), [a.id]);
  const click = useClickTool({ mask, natural, find, active: toolId === "click" });
  const detect = useDetectTool({ mask, natural, find, active: toolId === "detect" });
  const wand = useWandTool({ mask, natural, src: fileUrl(a.id) });
  const [sides, setSides] = useState<FrameSides>({ shape: "Custom", padLeft: 0, padTop: 0, padRight: 0, padBottom: 0 });
  const frame = useFrameTool({ natural, onSides: setSides });
  const { tools } = mask;
  const items: ToolbarItem[] = [tools.brush, tools.eraser, tools.box, tools.lasso, wand.tool, click.tool, detect.tool, "rule", tools.invert, ...(out ? [frame.tool] : []), HAND_TOOL];
  const tool = items.find((t): t is LayerTool => t !== "rule" && t.id === toolId) ?? null;
  const room = useRef<HTMLDivElement>(null);
  useLayerKeys({ items, onPick: setToolId, mask, root: room });
  const [grow, setGrow] = useState(GROW);
  // the frame dragged out: the bar outpaints, unless a mask is painted and a mask tool is in hand (that is the fix asked for)
  const outpainting = Boolean(out) && padded(frame.pads) && (toolId === "frame" || !mask.area);
  const options =
    toolId === "frame" ? <FrameOptions frame={frame} natural={natural} />
    : toolId === "wand" ? <WandOptions wand={wand} />
    : toolId === "click" ? <ClickOptions click={click} />
    : toolId === "detect" ? <DetectOptions detect={detect} />
    : <MaskOptions mask={mask} grow={grow} onGrow={setGrow} />;
  const job = outpainting ? out! : inpaint;
  if (!job || !natural) return null;
  return (
    <div ref={room} className="flex min-h-0 w-full grow flex-col items-center gap-2">
      <LayerStrip title={outpainting ? "Outpaint" : "Paint and fix"} className="w-full">{options}</LayerStrip>
      <div className="flex min-h-0 w-full grow items-start gap-3">
        <LayerToolbar items={items} active={toolId} onPick={setToolId} />
        <div className="relative flex h-full min-w-0 grow flex-col">
          {mask.failed && <ErrorNote>{mask.failed}</ErrorNote>}
          <ZoomPicture
            src={fileUrl(a.id)}
            natural={natural}
            panMode={toolId === HAND_TOOL.id ? "hand" : "layer"}
            // the room fits the frame while it is worked on, or while it holds something added
            canvas={toolId === "frame" || outpainting ? frame.canvas : undefined}
            overlay={(place) => <StageLayer place={place} tool={tool} mask={mask} />}
            imgProps={{ alt: "The picture being fixed", draggable: false }}
            className="min-h-0 flex-1"
          />
        </div>
      </div>
      {strip}
      <FixBar
        // the bar starts again on the other job: its prompt is about the painted part, or about what is added
        key={outpainting ? "outpaint" : "fix"}
        verb={outpainting ? "Outpaint" : "Fix"}
        tool={job}
        job={{ recipe: job, stored: acts.toolInput(job), label: outpainting ? "Outpaint" : "Inpaint", from: a.id, versionOf: a.id }}
        mask={outpainting ? frameSaid(sides) : maskSaid(mask.area, mask.soft)}
        grow={grow}
        busy={fix.isPending || fullForm.isPending || outpaint.isPending || outForm.isPending}
        onFix={(ask) => (outpainting ? outpaint.mutate({ ...ask, sides }) : void mask.png().then((png) => fix.mutate({ ...ask, png })))}
        onFullForm={(ask) => (outpainting ? outForm.mutate({ ...ask, sides }) : void (mask.area ? mask.png() : Promise.resolve(null)).then((png) => fullForm.mutate({ ...ask, png })))}
      />
    </div>
  );
}
