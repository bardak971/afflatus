import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, LoaderCircle, Pencil, Plus, TriangleAlert, Trash2 } from "lucide-react";
import { api, type Draft, type DraftBrief } from "../../api";
import { duplicateDraft, type useDraft } from "../../draft";
import { DraftMenu } from "./DraftMenu";
import { ask, askText } from "../../Confirm";
import { useBanners } from "../../store";
import { cx, fieldClass, TwoStep } from "../../ui";
import { queryKeys } from "../../queryKeys";

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
      return Promise.all([client.invalidateQueries({ queryKey: queryKeys.drafts.lists() }), client.invalidateQueries({ queryKey: queryKeys.drafts.one(v.id) })]);
    },
  });
  // Escape leaves the name box without keeping what was typed: the blur that follows must not save it
  const cancelledNaming = useRef(false);
  // a duplicate opens with its name box, once it is the draft open (the box renames the draft open)
  const [nameNext, setNameNext] = useState<string | null>(null);
  useEffect(() => {
    if (!draft || draft.id !== nameNext) return;
    setNameNext(null);
    cancelledNaming.current = false;
    setNaming(draft.name ?? "");
  }, [draft, nameNext]);
  // the delete asked first takes the whole row: the question with its two buttons, rather than squeezed in beside the menu
  const [deleting, setDeleting] = useState(false);
  if (deleting && draft) {
    return (
      <div className="flex h-[60px] shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="flex min-w-0 grow flex-col">
          <span className="truncate font-semibold">Delete this draft?</span>
          <span className="truncate text-xs text-ink-2">Its outputs stay in your library.</span>
        </span>
        <TwoStep title="Delete this draft" open stay yes="Delete" cancel="Keep" onCancel={() => setDeleting(false)} onYes={() => { setDeleting(false); void d.remove(draft.id).catch(failed("deleted")); }} />
      </div>
    );
  }
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
            onPick={(id) => void d.switchTo(id).catch(failed("opened"))}
            onNew={() => void d.startNew().catch(failed("started"))}
            onClearUnused={() => api.clearUnusedDrafts(draft?.id).then(() => client.invalidateQueries({ queryKey: queryKeys.drafts.lists() }), failed("cleared"))}
            // the open one is renamed and deleted as from the header's own buttons; another, asked in a dialog
            onRename={(x) => {
              if (x.id === draft?.id) {
                cancelledNaming.current = false;
                setNaming(draft.name ?? "");
                return;
              }
              void askText({ title: "Rename the draft", value: x.name ?? "", placeholder: "Draft name (empty: the start of the prompt)", yes: "Rename" }).then((name) => {
                if (name !== null && name !== (x.name ?? "")) rename.mutate({ id: x.id, name });
              });
            }}
            onDuplicate={(x) =>
              void duplicateDraft(x.id).then((made) => {
                client.setQueryData(queryKeys.drafts.one(made.id), made);
                void client.invalidateQueries({ queryKey: queryKeys.drafts.lists() });
                setNameNext(made.id);
                return d.switchTo(made.id);
              }).catch(failed("duplicated"))
            }
            onDelete={(x) => {
              if (x.id === draft?.id) return setDeleting(true);
              void ask({ title: "Delete this draft?", text: `${titleOf(x) || "This draft"} is deleted with its conversation with the designer. Its outputs stay in your library.`, yes: "Delete" }).then((ok) => {
                if (ok) void api.deleteDraft(x.id).then(() => client.invalidateQueries({ queryKey: queryKeys.drafts.lists() }), failed("deleted"));
              });
            }}
          />
        </div>
      )}
      {/* whether what is on screen is saved: a tick in the row rather than a line of its own (a failure also says why,
          with Retry, under the header); no draft open (yet), nothing is saved and nothing said */}
      {draft && <SaveState state={d.saving} />}
      <button type="button" aria-label="Rename this draft" data-tip="Rename this draft" disabled={!draft} onClick={() => { cancelledNaming.current = false; setNaming(draft?.name ?? ""); }} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><Pencil size={13} /></button>
      {/* deleted as everything else is: asked first (its conversation with the designer goes with it) */}
      <button type="button" aria-label="Delete this draft" data-tip="Delete this draft" disabled={!draft} onClick={() => setDeleting(true)} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"><Trash2 size={13} /></button>
      <button type="button" data-tip="New draft: an empty form. The open one stays in the drafts list." onClick={() => void d.startNew().catch(failed("started"))} className="flex h-9 shrink-0 items-center gap-1 rounded-lg border-[1.5px] border-dashed border-line-strong px-2.5 text-xs font-semibold text-ink-2 hover:text-ink"><Plus size={12} strokeWidth={2.6} /> New</button>
      {/* quiet, as the other tools of the row: folding the form away is not the panel's main action */}
      <button type="button" aria-label="Close the form" data-tip="Close the form" data-tip-keys="N" onClick={onClose} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-accent hover:bg-hover hover:brightness-125"><ChevronLeft size={18} strokeWidth={2.25} /></button>
    </div>
  );
}

/** The draft's save state as a small mark in the header: a tick once saved, a turning ring while saving, a warning when it could not be. */
function SaveState({ state }: { state: ReturnType<typeof useDraft>["saving"] }) {
  const tip = state === "saved" ? "Draft saved" : state === "saving" ? "Saving…" : "Not saved";
  return (
    <span role="status" aria-label={tip} data-tip={tip} className={cx("flex h-9 w-5 shrink-0 items-center justify-center", state === "failed" ? "text-warn-ink" : "text-ink-3")}>
      {state === "saved" ? <Check size={13} strokeWidth={2.4} /> : state === "saving" ? <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" /> : <TriangleAlert size={13} />}
    </span>
  );
}
