import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Entity } from "../api";
import { AutoText, Button, cx, ErrorNote, fieldClass } from "../ui";
import { queryKeys } from "../queryKeys";

/** A new snippet, kept under a name and a category: it starts with what the form's prompt holds. */
export function NewSnippet({ style, categories, first, onDone, onCancel }: {
  style: "tags" | "sentences";
  /** The categories there are, offered with a click. */
  categories: string[];
  /** What the main text box holds now. */
  first: string;
  onDone(made: Entity): void;
  onCancel(): void;
}) {
  const client = useQueryClient();
  const [adding, setAdding] = useState({ name: "", category: "", text: first.trim() });
  const save = useMutation({
    mutationFn: (v: { name: string; category: string; text: string }) => api.createEntity("snippet", v.name.trim(), { text: v.text.trim(), category: v.category.trim(), style }),
    onSuccess: (made) => {
      onDone(made);
      return client.invalidateQueries({ queryKey: queryKeys.entities() });
    },
  });
  return (
    <form
      className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-raised p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (adding.name.trim() && adding.text.trim()) save.mutate(adding);
      }}
    >
      <div className="flex gap-1.5">
        <input autoFocus aria-label="Name of the new snippet" placeholder="Name" maxLength={120} value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className={cx("h-8 min-w-0 grow", fieldClass)} />
        <input aria-label="Category of the new snippet" placeholder="Category (pose, light…)" maxLength={40} value={adding.category} onChange={(e) => setAdding({ ...adding, category: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className={cx("h-8 w-40 shrink-0", fieldClass)} />
      </div>
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {categories.map((c) => (
            <button key={c} type="button" onClick={() => setAdding({ ...adding, category: c })} className={cx("rounded-full px-2 py-0.5 text-[11px]", adding.category.trim().toLowerCase() === c.toLowerCase() ? "bg-line-strong text-ink-strong" : "bg-hover text-ink-2 hover:text-ink")}>{c}</button>
          ))}
        </div>
      )}
      <AutoText aria-label="Text of the new snippet" rows={2} placeholder={style === "tags" ? "tags, tags… {a|b} is a wildcard: one is picked each time" : "A sentence or two. {a|b} is a wildcard: one is picked each time"} value={adding.text} onChange={(e) => setAdding({ ...adding, text: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className={cx("py-1.5 text-[13px]", fieldClass)} />
      {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
      <div className="flex items-center justify-end gap-1.5">
        <span className="mr-auto text-xs text-ink-3">{first.trim() ? "Starts with the prompt in the form." : ""}</span>
        <Button size="sm" tone="quiet" onClick={onCancel}>Cancel</Button>
        <Button size="sm" tone="primary" type="submit" disabled={!adding.name.trim() || !adding.text.trim() || save.isPending}>Save</Button>
      </div>
    </form>
  );
}
