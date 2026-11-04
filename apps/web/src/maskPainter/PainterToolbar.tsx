import { Eraser, Redo2, Undo2 } from "lucide-react";
import { Button, CloseButton, Help } from "../ui";

/** How the painter is used, for its ?. */
const HOW = "Paint a little wider than the thing itself: only what is painted is redone, the rest stays as it is, and the feather fades the fix out. Tools: P brush, E eraser, B box, L lasso, W colour wand, X invert, H move; [ ] the brush's size, Shift+[ ] its feather, M shows the mask. Mouse wheel: zoom in where the pointer is. Space held or the middle button: drag the picture around.";

/** The painter's bar: undo, redo and start over, and Done. The tools are down the left, the brush on the strip under it. */
export function PainterToolbar({ canUndo, onUndo, canRedo, onRedo, canClear, onClear, error, saving, canSave, onSave, onClose }: {
  canUndo: boolean;
  onUndo(): void;
  canRedo: boolean;
  onRedo(): void;
  canClear: boolean;
  onClear(): void;
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
        <h2 className="text-base font-semibold whitespace-nowrap">Paint the mask</h2>
        <Help text={HOW} />
      </span>
      <Button size="sm" onClick={onUndo} disabled={!canUndo} data-tip="Undo the last stroke (Ctrl+Z)"><Undo2 size={14} /> Undo</Button>
      <Button size="sm" onClick={onRedo} disabled={!canRedo} data-tip="Redo it (Ctrl+Shift+Z)"><Redo2 size={14} /> Redo</Button>
      <Button size="sm" onClick={onClear} disabled={!canClear}><Eraser size={14} /> Start over</Button>
      <span className="grow" />
      {error && <span className="text-warn-ink">{error}</span>}
      <Button tone="primary" onClick={onSave} disabled={!canSave || saving}>{saving ? "Saving…" : "Done"}</Button>
      <CloseButton size={40} label="Close without saving" onClose={onClose} />
    </header>
  );
}
