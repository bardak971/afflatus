import { useMemo, useRef, useState, type ReactNode } from "react";
import { fileUrl } from "../api";
import { useKeysHere } from "../keys/here";
import { LayerStrip, MaskOptions } from "../stageLayer/LayerStrip";
import { LayerToolbar } from "../stageLayer/LayerToolbar";
import { StageLayer, useLayerKeys } from "../stageLayer/StageLayer";
import { HAND_TOOL, type LayerTool, type ToolbarItem } from "../stageLayer/tools";
import { useMaskLayer } from "../stageLayer/useMaskLayer";
import type { Rect } from "../stageLayer/raster";
import { ErrorNote } from "../ui";
import type { ViewerActions } from "../viewer/useViewerActions";
import { ZoomPicture } from "../viewer/ZoomPicture";
import { FixBar } from "./FixBar";
import { useFixJob } from "./useFixJob";

/** What the mask chip says of what is painted: nothing (null), or its size and whether its edge is soft. */
export const maskSaid = (area: Rect | null, soft: boolean): string | null => (area ? `${Math.round(area.w)}×${Math.round(area.h)}${soft ? ", soft" : ""}` : null);

/** How far the mask is grown before the fix when nothing else was asked (the mock's +8 px). */
const GROW = 8;

/**
 * Paint and fix (card #274): Inpaint on the Stage itself, no draft. The picture large with the mask layer over it
 * (stageLayer/), the tools on its left edge, the brush's size, feather and grow above it, the versions strip under it,
 * then the fix bar. Fix queues the picture's inpaint with the mask as versions of the picture; the mask stays while the
 * versions are flipped through (the same picture, the same framing: ViewerMedia keys this by the stack), and goes with Esc.
 */
export function PaintAndFix({ acts, strip, overlay }: {
  acts: ViewerActions;
  /** The versions strip (VersionStrip), drawn between the picture and the bar. */
  strip: ReactNode;
  overlay?: boolean;
}) {
  const { a } = acts;
  useKeysHere("paint", true, { over: overlay });
  // one object while the size holds: the layer starts its plane again when it changes, which wiped every stroke at each render
  const natural = useMemo(() => (a.width && a.height ? { w: a.width, h: a.height } : null), [a.width, a.height]);
  const mask = useMaskLayer({ natural });
  const { tools } = mask;
  const items: ToolbarItem[] = [tools.brush, tools.eraser, tools.box, tools.lasso, "rule", tools.invert, HAND_TOOL];
  const [toolId, setToolId] = useState("brush");
  const tool = items.find((t): t is LayerTool => t !== "rule" && t.id === toolId) ?? null;
  const room = useRef<HTMLDivElement>(null);
  useLayerKeys({ items, onPick: setToolId, mask, root: room });
  const [grow, setGrow] = useState(GROW);
  const { tool: inpaint, fix, fullForm } = useFixJob(acts);
  if (!inpaint || !natural) return null;
  return (
    <div ref={room} className="flex min-h-0 w-full grow flex-col items-center gap-2">
      <LayerStrip title="Paint and fix" className="w-full">
        <MaskOptions mask={mask} grow={grow} onGrow={setGrow} />
      </LayerStrip>
      <div className="flex min-h-0 w-full grow items-start gap-3">
        <LayerToolbar items={items} active={toolId} onPick={setToolId} />
        <div className="relative flex h-full min-w-0 grow flex-col">
          {mask.failed && <ErrorNote>{mask.failed}</ErrorNote>}
          <ZoomPicture
            src={fileUrl(a.id)}
            natural={natural}
            panMode={toolId === HAND_TOOL.id ? "hand" : "layer"}
            overlay={(place) => <StageLayer place={place} tool={tool} mask={mask} />}
            imgProps={{ alt: "The picture being fixed", draggable: false }}
            className="min-h-0 flex-1"
          />
        </div>
      </div>
      {strip}
      <FixBar
        tool={inpaint}
        job={{ recipe: inpaint, stored: acts.toolInput(inpaint), label: "Inpaint", from: a.id, versionOf: a.id }}
        mask={maskSaid(mask.area, mask.soft)}
        grow={grow}
        busy={fix.isPending || fullForm.isPending}
        onFix={(ask) => void mask.png().then((png) => fix.mutate({ ...ask, png }))}
        onFullForm={(ask) => void (mask.area ? mask.png() : Promise.resolve(null)).then((png) => fullForm.mutate({ ...ask, png }))}
      />
    </div>
  );
}
