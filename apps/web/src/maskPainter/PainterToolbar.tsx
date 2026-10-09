import { Eraser, Minus, Plus, Undo2, X } from "lucide-react";
import { Button, Help, Segmented } from "../ui";
import { Slider } from "../Slider";
import type { Tool } from "./useBrushCanvas";

/** How the painter is used, for its ?. */
const HOW = "Paint a little wider than the thing itself: only what is painted is redone, the rest stays as it is. Mouse wheel: zoom in where the pointer is. Move, or the space bar held: drag the picture around.";

/** The painter's bar: the tool, the brush, undo and start over, how close the picture is, and Done. */
export function PainterToolbar({ tool, onTool, brush, onBrush, canUndo, onUndo, canClear, onClear, zoom, maxZoom, onZoom, onWhole, error, saving, canSave, onSave, onClose }: {
  tool: Tool;
  onTool(tool: Tool): void;
  brush: number;
  onBrush(size: number): void;
  canUndo: boolean;
  onUndo(): void;
  canClear: boolean;
  onClear(): void;
  zoom: number;
  maxZoom: number;
  onZoom(zoom: number): void;
  onWhole(): void;
  error: string | null;
  saving: boolean;
  canSave: boolean;
  onSave(): void;
  onClose(): void;
}) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-panel px-5">
      {/* how to paint is behind the ?: the room under the bar is the picture's */}
      <span className="flex items-center gap-1.5">
        <h2 className="text-base font-semibold">Paint the mask</h2>
        <Help text={HOW} />
      </span>
      <Segmented<Tool> label="Tool" value={tool} options={[{ value: "paint", label: "Paint" }, { value: "erase", label: "Rub out" }, { value: "move", label: "Move" }]} onChange={onTool} />
      <span className="flex items-center gap-2 text-ink-2">
        Brush
        <Slider label="Size of the brush" value={brush} min={8} max={300} step={2} unit="px" onChange={onBrush} className="w-56" />
      </span>
      <Button size="sm" onClick={onUndo} disabled={!canUndo} data-tip="Undo the last stroke (Ctrl+Z)"><Undo2 size={14} /> Undo</Button>
      <Button size="sm" onClick={onClear} disabled={!canClear}><Eraser size={14} /> Start over</Button>
      <span className="flex items-center gap-1">
        <button type="button" aria-label="Further away" data-tip="Further away" disabled={zoom <= 1} onClick={() => onZoom(zoom / 1.5)} className="flex h-8 w-8 items-center justify-center rounded-md border border-line-strong hover:bg-hover disabled:opacity-40"><Minus size={14} /></button>
        <span className="w-12 text-center text-xs text-ink-2 tabular-nums">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Closer" data-tip="Closer" disabled={zoom >= maxZoom} onClick={() => onZoom(zoom * 1.5)} className="flex h-8 w-8 items-center justify-center rounded-md border border-line-strong hover:bg-hover disabled:opacity-40"><Plus size={14} /></button>
        <Button size="sm" onClick={onWhole} disabled={zoom === 1}>Whole picture</Button>
      </span>
      <span className="grow" />
      {error && <span className="text-warn-ink">{error}</span>}
      <Button tone="primary" onClick={onSave} disabled={!canSave || saving}>{saving ? "Saving…" : "Done"}</Button>
      <button type="button" aria-label="Close without saving" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"><X size={18} /></button>
    </header>
  );
}
