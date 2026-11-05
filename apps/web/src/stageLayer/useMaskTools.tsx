import type { ReactNode } from "react";
import type { Size } from "../viewer/zoom";
import { ClickOptions, DetectOptions, WandOptions } from "./LayerStrip";
import type { LayerTool } from "./tools";
import { useClickTool, useDetectTool, useWandTool, type Find } from "./useFindTools";
import type { MaskLayer } from "./useMaskLayer";

/** What a picture without a way to run the find jobs finds: nothing (its click and detector are not shown). */
const noFind: Find = async () => [];

/**
 * The mask's tools as the form's painter and Paint and fix both show them: the brush, the eraser, the box (or `box`, the
 * same tool under another key), the lasso, the colour wand, then click to mask and the detector when `find` runs their jobs;
 * and the strip's options for the find tools when one of them is in hand (null for the others: the caller's mask options).
 */
export function useMaskTools({ mask, natural, src, find, toolId, box }: {
  mask: MaskLayer;
  natural: Size | null;
  src: string;
  find?: Find;
  toolId: string;
  box?: LayerTool;
}) {
  const wand = useWandTool({ mask, natural, src });
  // without a way to run their jobs they are not shown; the hooks are called all the same, as hooks must be
  const click = useClickTool({ mask, natural, find: find ?? noFind, active: toolId === "click" });
  const detect = useDetectTool({ mask, natural, find: find ?? noFind, active: Boolean(find) && toolId === "detect" });
  const { tools } = mask;
  const items: LayerTool[] = [tools.brush, tools.eraser, box ?? tools.box, tools.lasso, wand.tool, ...(find ? [click.tool, detect.tool] : [])];
  const options: ReactNode =
    toolId === "wand" ? <WandOptions wand={wand} />
    : toolId === "click" && find ? <ClickOptions click={click} />
    : toolId === "detect" && find ? <DetectOptions detect={detect} />
    : null;
  return { items, options };
}
