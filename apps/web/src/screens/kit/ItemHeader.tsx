import { FileDown, Play, Trash2, X } from "lucide-react";
import type { Entity } from "../../api";
import { savePresetFile } from "../../presetFile";
import { Button, cx, TwoStep } from "../../ui";

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
  onDelete(): void;
  onClose(): void;
}) {
  return (
    <div className="flex items-center gap-3">
      <input aria-label="Name" value={item.name} onChange={(e) => onRename(e.target.value)} className="h-11 min-w-0 grow rounded-lg border border-transparent bg-transparent px-2 text-xl font-semibold hover:border-line focus:border-accent focus:bg-raised" />
      <span data-tip={saved === "failed" ? failure ?? undefined : undefined} className={cx("flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px]", saved === "failed" ? "bg-warn-wash text-warn-ink" : "bg-raised text-ink-2")}>
        {saved === "saved" ? "Saved" : saved === "saving" ? "Saving…" : `Could not save${failure ? `: ${failure}` : ""}`}
        {saved === "failed" && <button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2">Retry</button>}
      </span>
      {item.kind === "preset" && (
        <>
          <Button size="sm" tone="primary" onClick={onApply} className="flex items-center gap-1.5"><Play size={13} /> Apply in Studio</Button>
          <Button size="sm" onClick={() => savePresetFile(item)} data-tip="A file another Afflatus can import, or a preset to contribute" className="flex items-center gap-1.5"><FileDown size={13} /> Save as a file</Button>
        </>
      )}
      <TwoStep title={`Delete ${item.name}`} icon={<Trash2 size={15} />} note={noteOfDelete(item)} yes="Delete" cancel="Keep" onYes={onDelete} className="h-9 w-9 rounded-lg" />
      <button type="button" aria-label="Close" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={15} /></button>
    </div>
  );
}
