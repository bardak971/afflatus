import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SquarePen } from "lucide-react";
import { MAX_BOXES, type RegionValue } from "@afflatus/core";
import { fileUrl } from "../api";
import { plural } from "../format";
import { dialogOver, OVER } from "../Dialog";
import { Keys, typing } from "../Keys";
import { useKeysHere } from "../keys/here";
import { useRegionTool } from "../regions/useRegionTool";
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
import { BoxBar } from "./BoxBar";
import { useBoxEditors } from "./boxEditors";
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

/**
 * What the strip says of the edit boxes drawn on this picture: how many, and the most there may be. "1 of 8 boxes" read as one
 * box shown out of eight kept somewhere, so the cap is said as a cap.
 */
export const boxesSaid = (count: number): string => (count ? `${plural(count, "box", "boxes")} · ${MAX_BOXES} at most` : "No box yet");

/** The strip while an edit's boxes are drawn or moved: how many, and what the keys do; the boxes have no setting of their own. */
function BoxOptions({ count }: { count: number }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-2">
      {boxesSaid(count)} · <Keys keys="B" size="sm" /> draws one · <Keys keys="V" size="sm" /> picks and moves one · each box its own instruction in the bar
    </span>
  );
}

/** How far the mask is grown before the fix when nothing else was asked (the mock's +8 px). */
const GROW = 8;

/**
 * Paint and fix (card #274): Inpaint, Outpaint and Edit on the Stage itself, no draft. The picture large with the drawing layer
 * over it (stageLayer/), the tools on its left edge (the mask's, click to mask C and the detectors D over the server's
 * find-mask jobs, the colour wand W, the outpaint frame R), the active tool's options above it, the versions strip under
 * it, then the bar. The bar fixes the painted part, or outpaints once the frame is dragged out; either comes back as
 * versions of the picture. The mask stays while the versions are flipped through (ViewerMedia keys this by the stack).
 */
export function PaintAndFix({ acts, mode, strip, overlay }: {
  acts: ViewerActions;
  /** Outpaint (R) starts on the frame; Inpaint (I) and Edit (E) on the brush, Edit's bar on the whole picture until a part is painted. */
  mode: StageMode;
  /** The versions strip (VersionStrip), drawn between the picture and the bar. */
  strip: ReactNode;
  overlay?: boolean;
}) {
  const { a } = acts;
  useKeysHere("paint", true, { over: overlay });
  const natural = useMemo(() => (a.width && a.height ? { w: a.width, h: a.height } : null), [a.width, a.height]);
  const mask = useMaskLayer({ natural });
  const { tool: inpaint, fix, fullForm, out, outpaint, outForm, editTool, edit, editForm, boxEdit } = useFixJob(acts);
  // Edit in box (card #284): boxes drawn with B, each with its instruction, done by an instruction editor
  const { editors, start } = useBoxEditors(acts.madeWith?.family);
  const [picked, setPicked] = useState<string | null>(null);
  const editor = editors.find((e) => e.family === picked) ?? start;
  const [boxes, setBoxes] = useState<RegionValue[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const boxTools = useRegionTool({ spec: { max: MAX_BOXES }, regions: boxes, natural, selected, onSelect: setSelected, onChange: setBoxes, nameOf: () => undefined });
  const [toolId, setToolId] = useState(mode === "outpaint" && out ? "frame" : mode === "edit" && editor ? "box" : "brush");
  // the finds run on the picture shown (a version is a picture of its own)
  const find = useMemo(() => findOn(a.id), [a.id]);
  const click = useClickTool({ mask, natural, find, active: toolId === "click" });
  const detect = useDetectTool({ mask, natural, find, active: toolId === "detect" });
  const wand = useWandTool({ mask, natural, src: fileUrl(a.id) });
  const [sides, setSides] = useState<FrameSides>({ shape: "Custom", padLeft: 0, padTop: 0, padRight: 0, padBottom: 0 });
  const frame = useFrameTool({ natural, onSides: setSides });
  const { tools } = mask;
  // with an editor, B draws an edit's box (V picks and moves one) and the mask's box is O; without one, B is the mask's box.
  // The edit box has a pen in its square, so it does not read as the rectangle mask's dashed square below it
  const boxing: ToolbarItem[] = editor ? [
    boxTools.select,
    { ...boxTools.box, label: "Edit box", icon: SquarePen, tip: "Drag a box where an edit model is to follow an instruction, then say it in the bar; a click on a box picks it" },
    "rule",
  ] : [];
  const maskBox = editor ? { ...tools.box, id: "maskBox", key: "O" } : tools.box;
  const items: ToolbarItem[] = [...boxing, tools.brush, tools.eraser, maskBox, tools.lasso, wand.tool, click.tool, detect.tool, "rule", tools.invert, ...(out ? [frame.tool] : []), HAND_TOOL];
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
    // "box" is the edit box with an editor; without one it is the rectangle mask, whose options are the mask's
    : (toolId === "box" && editor) || toolId === "select" ? <BoxOptions count={boxes.length} />
    : <MaskOptions mask={mask} grow={grow} onGrow={setGrow} />;
  // boxes drawn and nothing painted: the bar edits in them; a part painted is the fix asked for, the boxes left for later
  const inBoxes = Boolean(editor) && boxes.length > 0 && !outpainting && !mask.area;
  // Edit (E) works on the whole picture until a part is painted, which is then the fix asked for
  const editing = !outpainting && mode === "edit" && Boolean(editTool) && !mask.area;
  // Del removes the box picked, Esc lets it go (then, the next Esc, leaves Paint and fix): before the viewer hears it; not
  // while a list or a popover is open over the Stage, whose Esc is its own
  const keys = useRef({ selected, boxes });
  keys.current = { selected, boxes };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (!k.selected || e.defaultPrevented || typing(e) || e.ctrlKey || e.metaKey || e.altKey || dialogOver(room.current) || document.querySelector(OVER)) return;
      if (e.key === "Delete" || e.key === "Backspace") setBoxes(k.boxes.filter((b) => b.id !== k.selected));
      else if (e.key !== "Escape") return;
      e.preventDefault();
      setSelected(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const verb = outpainting ? "Outpaint" : editing ? "Edit" : "Fix";
  const job = outpainting ? out! : editing ? editTool! : inpaint;
  if (!job || !natural) return null;
  return (
    <div ref={room} className="flex min-h-0 w-full grow flex-col items-center gap-2">
      <LayerStrip title={inBoxes ? "Edit in box" : verb === "Fix" ? "Paint and fix" : verb} className="w-full shrink-0">{options}</LayerStrip>
      <div className="flex min-h-0 w-full grow items-start gap-3">
        {/* a short Stage (1280 × 800 with the form open) holds fewer tools than the bar has: it scrolls rather than run over the strip */}
        <LayerToolbar items={items} active={toolId} onPick={setToolId} className="max-h-full overflow-y-auto [scrollbar-width:none]" />
        <div className="relative flex h-full min-w-0 grow flex-col">
          {mask.failed && <ErrorNote>{mask.failed}</ErrorNote>}
          <ZoomPicture
            src={fileUrl(a.id)}
            natural={natural}
            panMode={toolId === HAND_TOOL.id ? "hand" : "layer"}
            // the room fits the frame while it is worked on, or while it holds something added
            canvas={toolId === "frame" || outpainting ? frame.canvas : undefined}
            overlay={(place) => <StageLayer place={place} tool={tool} mask={mask}>{editor && boxTools.view(place)}</StageLayer>}
            imgProps={{ alt: "The picture being fixed", draggable: false }}
            className="min-h-0 flex-1"
          />
        </div>
      </div>
      {strip}
      {inBoxes && editor ? (
        <BoxBar
          boxes={boxes}
          selected={selected}
          onSelect={setSelected}
          onPrompt={(id, prompt) => setBoxes((list) => list.map((b) => (b.id === id ? { ...b, prompt } : b)))}
          editors={editors}
          editor={editor}
          onEditor={setPicked}
          job={{ recipe: editor.recipe, stored: acts.toolInput(editor.recipe), label: "Edit in box", from: a.id, versionOf: a.id }}
          busy={boxEdit.isPending}
          onEdit={(tuned) => boxEdit.mutate({ recipe: editor.recipe, boxes, tuned })}
        />
      ) : (
      <FixBar
        // the bar starts again on the other job: its prompt is about the painted part, or about what is added
        key={verb}
        verb={verb}
        tool={job}
        job={{ recipe: job, stored: acts.toolInput(job), label: verb === "Fix" ? "Inpaint" : verb, from: a.id, versionOf: a.id }}
        mask={outpainting ? frameSaid(sides) : maskSaid(mask.area, mask.soft)}
        grow={grow}
        // the boxes are this picture's own (this component is keyed by its stack): a mask painted over them takes the bar
        boxes={editor ? { count: boxes.length, onClearMask: mask.clear } : undefined}
        note={mode === "edit" && !editTool ? "No edit model for this picture: paint the part to change, and Fix redoes it" : undefined}
        busy={fix.isPending || fullForm.isPending || outpaint.isPending || outForm.isPending || edit.isPending || editForm.isPending}
        onFix={(ask) => (outpainting ? outpaint.mutate({ ...ask, sides }) : editing ? edit.mutate(ask) : void mask.png().then((png) => fix.mutate({ ...ask, soft: mask.soft, png })))}
        onFullForm={(ask) => (outpainting ? outForm.mutate({ ...ask, sides }) : editing ? editForm.mutate(ask) : void (mask.area ? mask.png() : Promise.resolve(null)).then((png) => fullForm.mutate({ ...ask, soft: mask.soft, png })))}
      />
      )}
    </div>
  );
}
