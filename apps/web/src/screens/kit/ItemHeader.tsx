import { Check, FileDown, Link2, MoreHorizontal, Play } from "lucide-react";
import type { Entity } from "../../api";
import { savePresetFile } from "../../presetFile";
import { Button, Chip, CloseButton, cx, IconButton } from "../../ui";
import { kitHref } from "./link";
import { useCopied } from "../../hooks";

/** What deleting an item does, said before it is done. */
export const noteOfDelete = (e: Entity) => (e.kind === "person" || e.kind === "place" ? "Images picked from your library stay there; images uploaded here go to the bin with it." : "It cannot be brought back.");

/** The address of an item of the kit, to the clipboard: pasted in another tab, it opens the kit on that item. */
export function CopyLink({ item }: { item: Entity }) {
  const { copied, copy } = useCopied();
  const href = `${window.location.origin}${kitHref(item.kind, item.id)}`;
  return (
    <Button size="sm" data-tip={href} onClick={() => copy(href)} className="flex shrink-0 items-center gap-1.5">
      {copied ? <Check size={13} /> : <Link2 size={13} />} {copied ? "Copied" : "Copy link"}
    </Button>
  );
}

/** The head of the item open in the Prompt kit: its name to change, whether it is saved, and what can be done with it. */
export function ItemHeader({ item, saved, failure, by, onRename, onRetry, onApply, onMenu, onClose }: {
  item: Entity;
  /** Its name was changed by an MCP token, and the user has not edited it since: ringed, the token's name after it (agentEdits.ts). */
  by?: string;
  saved: "saved" | "saving" | "failed";
  /** Why the last save failed, in the server's words. */
  failure: string | null;
  onRename(name: string): void;
  onRetry(): void;
  /** A preset: put in the form in Studio. */
  onApply(): void;
  /** Opens the row's menu for this item, where Delete… lives (it asks first). */
  onMenu(e: React.MouseEvent): void;
  onClose(): void;
}) {
  return (
    <div className="flex items-center gap-3">
      <input aria-label="Name" data-agent={by} value={item.name} onChange={(e) => onRename(e.target.value)} className={cx("h-11 min-w-0 grow rounded-lg border border-transparent bg-transparent -ml-2 px-2 text-display font-bold hover:border-line focus:border-accent focus:bg-raised", by && "ring-1 ring-picture/55")} />
      {by && <span className="shrink-0 text-meta font-medium text-picture">· {by}</span>}
      <Chip tone={saved === "failed" ? "warn" : saved === "saved" ? "good" : "neutral"} tip={saved === "failed" ? failure ?? undefined : undefined}>
        {saved === "saved" ? "Saved" : saved === "saving" ? "Saving…" : `Could not save${failure ? `: ${failure}` : ""}`}
        {saved === "failed" && <button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2">Retry</button>}
      </Chip>
      <CopyLink item={item} />
      {item.kind === "preset" && (
        <>
          <Button size="sm" tone="primary" onClick={onApply} className="flex items-center gap-1.5"><Play size={13} /> Apply in Studio</Button>
          <Button size="sm" onClick={() => savePresetFile(item)} data-tip="A file another Afflatus can import, or a preset to contribute" className="flex items-center gap-1.5"><FileDown size={13} /> Save as a file</Button>
        </>
      )}
      {/* Delete sits in the menu, not next to ×: one misclick there lost an item, and the kit has no undo. */}
      <IconButton label={`More actions on ${item.name}`} tip="More: Delete…" aria-haspopup="menu" onClick={onMenu}><MoreHorizontal size={16} /></IconButton>
      <CloseButton onClose={onClose} className="ml-3" />
    </div>
  );
}
