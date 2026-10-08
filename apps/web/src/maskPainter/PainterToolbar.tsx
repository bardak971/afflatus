import { Eraser, Minus, Plus, Undo2, X } from "lucide-react";
import { Button, NumberBox, Segmented } from "../ui";
import type { Tool } from "./useBrushCanvas";

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
      <h2 className="text-base font-semibold">Paint the mask</h2>
      <Segmented<Tool> label="Tool" value={tool} options={[{ value: "paint", label: "Paint" }, { value: "erase", label: "Rub out" }, { value: "move", label: "Move" }]} onChange={onTool} />
      <label className="flex items-center gap-2 text-ink-2">
        Brush
        <input type="range" min={8} max={300} step={2} value={brush} aria-label="Size of the brush" onChange={(e) => onBrush(Number(e.target.value))} className="w-36 accent-accent" />
        <NumberBox label="Size of the brush" value={brush} min={8} max={300} step={2} unit="px" onCommit={onBrush} />
      </label>
      <Button size="sm" onClick={onUndo} disabled={!canUndo} title="Undo the last stroke (Ctrl+Z)"><Undo2 size={14} /> Undo</Button>
      <Button size="sm" onClick={onClear} disabled={!canClear}><Eraser size={14} /> Start over</Button>
      <span className="flex items-center gap-1">
        <button type="button" aria-label="Further away" title="Further away" disabled={zoom <= 1} onClick={() => onZoom(zoom / 1.5)} className="flex h-8 w-8 items-center justify-center rounded-md border border-line-strong hover:bg-hover disabled:opacity-40"><Minus size={14} /></button>
        <span className="w-12 text-center text-xs text-ink-2 tabular-nums">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Closer" title="Closer" disabled={zoom >= maxZoom} onClick={() => onZoom(zoom * 1.5)} className="flex h-8 w-8 items-center justify-center rounded-md border border-line-strong hover:bg-hover disabled:opacity-40"><Plus size={14} /></button>
        <Button size="sm" onClick={onWhole} disabled={zoom === 1}>Whole picture</Button>
      </span>
      <span className="grow" />
      {error && <span className="text-warn-ink">{error}</span>}
      <Button tone="primary" onClick={onSave} disabled={!canSave || saving}>{saving ? "Saving…" : "Done"}</Button>
      <button type="button" aria-label="Close without saving" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"><X size={18} /></button>
    </header>
  );
}
