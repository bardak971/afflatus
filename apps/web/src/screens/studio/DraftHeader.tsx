import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { api, type Draft, type DraftBrief } from "../../api";
import { DRAFT_LIST } from "../../data";
import type { useDraft } from "../../draft";
import { DraftMenu } from "./DraftMenu";
import { useBanners } from "../../store";
import { fieldClass, TwoStep } from "../../ui";

/**
 * The head of the Create panel: the draft it is on (a list to switch, a name of its own), and the way to a
 * new one, to delete this one, and to fold the form away.
 */
export function DraftHeader({ d, draft, titleOf, onClose }: {
  d: ReturnType<typeof useDraft>;
  draft: Draft | null;
  /** What a draft is called in the list: its name, else the start of its prompt, else "" (the menu names it after its model). */
  titleOf(x: DraftBrief): string;
  onClose(): void;
}) {
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  /** A draft action that failed, said where it is seen whatever is open. */
  const failed = (what: string) => (err: Error) => say({ id: `draft:${what}`, tone: "bad", title: `The draft could not be ${what}`, text: err.message, href: "/create", go: "Open the form" });
  // a draft being given a name of its own, instead of the start of what is written in it
  const [naming, setNaming] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.saveDraft(v.id, { name: v.name }),
    onError: failed("renamed"),
    onSettled: (_d, _e, v) => {
      setNaming(null);
      // the open draft takes its new name from its own query (see useDraft), the list from the list
      return Promise.all([client.invalidateQueries({ queryKey: DRAFT_LIST }), client.invalidateQueries({ queryKey: ["drafts", v.id] })]);
    },
  });
  // Escape leaves the name box without keeping what was typed: the blur that follows must not save it
  const cancelledNaming = useRef(false);
  return (
    <div className="flex h-[60px] shrink-0 items-center gap-1.5 border-b border-line px-3">
      {naming !== null && draft ? (
        <form
          className="flex min-w-0 grow"
          onSubmit={(e) => {
            e.preventDefault();
            rename.mutate({ id: draft.id, name: naming });
          }}
        >
          <input
            autoFocus
            aria-label="Draft name"
            placeholder="Draft name (empty: the start of the prompt)"
            value={naming}
            maxLength={80}
            onChange={(e) => setNaming(e.target.value)}
            onBlur={() => {
              if (cancelledNaming.current) {
                cancelledNaming.current = false;
                return;
              }
              if (naming !== null) rename.mutate({ id: draft.id, name: naming });
            }}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              cancelledNaming.current = true;
              setNaming(null);
            }}
            className={`${fieldClass} h-9 min-w-0 grow font-semibold placeholder:font-normal`}
          />
        </form>
      ) : (
        <div className="min-w-0 grow">
          <DraftMenu
            drafts={d.drafts}
            open={draft}
            titleOf={titleOf}
            // the open one is never cleared: not counted when it is one of them
            unused={Math.max(0, d.unused - (draft && !draft.name && !titleOf(draft) && !d.drafts.find((x) => x.id === draft.id)?.outputs ? 1 : 0))}
            onPick={(id) => void d.switchTo(id).catch(failed("opened"))}
            onNew={() => void d.startNew().catch(failed("started"))}
            onClearUnused={() => api.clearUnusedDrafts(draft?.id).then(() => client.invalidateQueries({ queryKey: DRAFT_LIST }), failed("cleared"))}
          />
        </div>
      )}
      <button type="button" aria-label="Rename this draft" data-tip="Rename this draft" disabled={!draft} onClick={() => { cancelledNaming.current = false; setNaming(draft?.name ?? ""); }} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><Pencil size={13} /></button>
      {/* deleted as everything else is: asked first (its conversation with the designer goes with it) */}
      <TwoStep
        title="Delete this draft"
        icon={<Trash2 size={13} />}
        note="Its outputs stay in your library."
        yes="Delete"
        cancel="Keep"
        disabled={!draft}
        onYes={() => draft && void d.remove(draft.id).catch(failed("deleted"))}
        className="h-9 w-8 rounded-lg"
      />
      <button type="button" data-tip="New draft: an empty form. This one is kept." onClick={() => void d.startNew().catch(failed("started"))} className="flex h-9 shrink-0 items-center gap-1 rounded-lg border-[1.5px] border-dashed border-line-strong px-2.5 text-xs font-semibold text-ink-2 hover:text-ink"><Plus size={12} strokeWidth={2.6} /> New</button>
      <button type="button" aria-label="Close the form" data-tip="Fold the form away: the library takes the whole width. N opens it again." onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/50 text-accent hover:bg-accent-wash"><ChevronLeft size={15} /></button>
    </div>
  );
}
