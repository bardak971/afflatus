import { FileDown, Play, Trash2, X } from "lucide-react";
import type { Entity } from "../../api";
import { savePresetFile } from "../../presetFile";
import { Button, Chip } from "../../ui";

/** What deleting an item does, said before it is done. */
export const noteOfDelete = (e: Entity) => (e.kind === "person" || e.kind === "place" ? "Images picked from your library stay there; images uploaded here go to the bin with it." : "It cannot be brought back.");

/** The head of the item open in the Prompt kit: its name to change, whether it is saved, and what can be done with it. */
export function ItemHeader({ item, saved, failure, onRename, onRetry, onApply, onDelete, onClose }: {
  item: Entity;
  saved: "saved" | "saving" | "failed";
  /** Why the last save failed, in the server's words. */
  failure: string | null;
  onRename(name: string): void;
  onRetry(): void;
  /** A preset: put in the form in Studio. */
  onApply(): void;
  /** Asks first (the question the row's menu asks), then deletes. */
  onDelete(): void;
  onClose(): void;
}) {
  return (
    <div className="flex items-center gap-3">
      <input aria-label="Name" value={item.name} onChange={(e) => onRename(e.target.value)} className="h-11 min-w-0 grow rounded-lg border border-transparent bg-transparent -ml-2 px-2 text-[22px] font-bold hover:border-line focus:border-accent focus:bg-raised" />
      <Chip tone={saved === "failed" ? "warn" : saved === "saved" ? "good" : "neutral"} tip={saved === "failed" ? failure ?? undefined : undefined}>
        {saved === "saved" ? "Saved" : saved === "saving" ? "Saving…" : `Could not save${failure ? `: ${failure}` : ""}`}
        {saved === "failed" && <button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2">Retry</button>}
      </Chip>
      {item.kind === "preset" && (
        <>
          <Button size="sm" tone="primary" onClick={onApply} className="flex items-center gap-1.5"><Play size={13} /> Apply in Studio</Button>
          <Button size="sm" onClick={() => savePresetFile(item)} data-tip="A file another Afflatus can import, or a preset to contribute" className="flex items-center gap-1.5"><FileDown size={13} /> Save as a file</Button>
        </>
      )}
      <button type="button" aria-label={`Delete ${item.name}`} data-tip="Delete…" onClick={onDelete} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><Trash2 size={15} /></button>
      <button type="button" aria-label="Close" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={15} /></button>
    </div>
  );
}
