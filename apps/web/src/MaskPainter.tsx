import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, fileUrl } from "./api";
import { dialogOver } from "./Dialog";
import { useKeysHere } from "./keys/here";
import { useLeave } from "./leave";
import { nameFor } from "./maskName";
import { PainterToolbar } from "./maskPainter/PainterToolbar";
import { ClickOptions, DetectOptions, LayerStrip, MaskOptions, WandOptions } from "./stageLayer/LayerStrip";
import { LayerToolbar } from "./stageLayer/LayerToolbar";
import { loadImage } from "./stageLayer/maskImage";
import { StageLayer, useLayerKeys } from "./stageLayer/StageLayer";
import { HAND_TOOL, type LayerTool, type ToolbarItem } from "./stageLayer/tools";
import { useClickTool, useDetectTool, useWandTool, type Find } from "./stageLayer/useFindTools";
import { useMaskLayer } from "./stageLayer/useMaskLayer";
import { ErrorNote } from "./ui";
import type { Size } from "./viewer/zoom";
import { ZoomPicture } from "./viewer/ZoomPicture";

/**
 * The form's painter, over the whole screen: the Stage's drawing layer (stageLayer/) on the picture, with the mask's
 * tools (the soft brush, the eraser, box, lasso, the colour wand, invert; click to mask and the detector when `find` runs
 * their jobs) and the Hand, zoom and pan as the viewer's, undo and redo. A
 * chunk of its own, fetched when a mask is first painted (MaskField). What it saves is the mask at the picture's own size,
 * grey where the feather fades, as the recipes read it.
 */
export function MaskPainter({ picture, mask, find, onDone, onClose }: { picture: string; mask: string | null; find?: Find; onDone(id: string): void; onClose(): void }) {
  useKeysHere("mask", true, { over: true });
  // it comes in as a panel and fades as a still copy when closed or saved (the strokes copied as they are)
  const painterRef = useLeave<HTMLDivElement>("m-out");
  const [natural, setNatural] = useState<Size | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    loadImage(fileUrl(picture)).then(
      (img) => !gone && setNatural({ w: img.naturalWidth, h: img.naturalHeight }),
      (err: Error) => !gone && setFailed(err.message),
    );
    return () => {
      gone = true;
    };
  }, [picture]);
  const layer = useMaskLayer({ natural, from: mask });
  const { tools } = layer;
  const [toolId, setToolId] = useState("brush");
  const wand = useWandTool({ mask: layer, natural, src: fileUrl(picture) });
  // without a way to run their jobs they are not shown; the hooks are called all the same, as hooks must be
  const noFind: Find = async () => [];
  const click = useClickTool({ mask: layer, natural, find: find ?? noFind, active: toolId === "click" });
  const detect = useDetectTool({ mask: layer, natural, find: find ?? noFind, active: Boolean(find) && toolId === "detect" });
  const items: ToolbarItem[] = [tools.brush, tools.eraser, tools.box, tools.lasso, wand.tool, ...(find ? [click.tool, detect.tool] : []), "rule", tools.invert, HAND_TOOL];
  const tool = items.find((t): t is LayerTool => t !== "rule" && t.id === toolId) ?? null;
  const room = useRef<HTMLDivElement>(null);
  useLayerKeys({ items, onPick: setToolId, mask: layer, root: room });

  // Esc closes, unless a modal over the painter (the keyboard shortcuts) has the keys
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !dialogOver(room.current) && close.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const save = useMutation({
    mutationFn: async () => api.upload(new File([await layer.png()], nameFor(picture), { type: "image/png" }), { mask: true }),
    onSuccess: (a) => onDone(a.id),
  });

  return (
    <div ref={painterRef} data-stage role="dialog" aria-modal="true" aria-label="Paint the mask" className="m-panel fixed inset-0 z-50 flex flex-col bg-stage/95">
      <PainterToolbar
        canUndo={layer.steps > 0} onUndo={layer.undo} canRedo={layer.redos > 0} onRedo={layer.redo} canClear={Boolean(layer.area)} onClear={layer.clear}
        error={save.isError ? save.error.message : null} saving={save.isPending} canSave={layer.ready} onSave={() => save.mutate()} onClose={onClose}
      />
      <LayerStrip title="Mask" className="border-b border-line bg-panel px-5 py-1">
        {toolId === "wand" ? <WandOptions wand={wand} /> : toolId === "click" ? <ClickOptions click={click} /> : toolId === "detect" ? <DetectOptions detect={detect} /> : <MaskOptions mask={layer} />}
      </LayerStrip>
      <div ref={room} className="flex min-h-0 grow gap-4 p-6">
        <LayerToolbar items={items} active={toolId} onPick={setToolId} className="self-start" />
        <div className="relative min-w-0 grow">
          {(failed ?? layer.failed) && <ErrorNote>{failed ?? layer.failed}</ErrorNote>}
          {natural && (
            <ZoomPicture
              src={fileUrl(picture)}
              natural={natural}
              panMode={toolId === HAND_TOOL.id ? "hand" : "layer"}
              overlay={(place) => <StageLayer place={place} tool={tool} mask={layer} />}
            />
          )}
        </div>
      </div>
    </div>
  );
}
