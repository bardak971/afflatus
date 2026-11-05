import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { fileUrl } from "./api";
import { dialogOver } from "./Dialog";
import { useKeysHere } from "./keys/here";
import { useLeave } from "./leave";
import { uploadMask } from "./maskName";
import { PainterToolbar } from "./maskPainter/PainterToolbar";
import { LayerStrip, MaskOptions } from "./stageLayer/LayerStrip";
import { LayerToolbar } from "./stageLayer/LayerToolbar";
import { loadImage } from "./stageLayer/maskImage";
import { StageLayer, useLayerKeys } from "./stageLayer/StageLayer";
import { HAND_TOOL, isTool, type LayerTool, type ToolbarItem } from "./stageLayer/tools";
import type { Find } from "./stageLayer/useFindTools";
import { useMaskLayer } from "./stageLayer/useMaskLayer";
import { useMaskTools } from "./stageLayer/useMaskTools";
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
  const maskTools = useMaskTools({ mask: layer, natural, src: fileUrl(picture), find, toolId });
  const items: ToolbarItem[] = [...maskTools.items, "rule", tools.invert, HAND_TOOL];
  const tool = items.find((t): t is LayerTool => isTool(t) && t.id === toolId) ?? null;
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
    mutationFn: async () => uploadMask(picture, await layer.png()),
    onSuccess: (a) => onDone(a.id),
  });

  return (
    <div ref={painterRef} data-stage role="dialog" aria-modal="true" aria-label="Paint the mask" className="m-panel fixed inset-0 z-50 flex flex-col bg-stage/95">
      <PainterToolbar
        canUndo={layer.steps > 0} onUndo={layer.undo} canRedo={layer.redos > 0} onRedo={layer.redo} canClear={Boolean(layer.area)} onClear={layer.clear}
        error={save.isError ? save.error.message : null} saving={save.isPending} canSave={layer.ready} onSave={() => save.mutate()} onClose={onClose}
      />
      <LayerStrip title="Mask" className="border-b border-line bg-panel px-5 py-1">
        {maskTools.options ?? <MaskOptions mask={layer} />}
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
