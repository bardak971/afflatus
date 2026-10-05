import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings } from "../../data";
import { AutoText, Button, ErrorNote, Toggle } from "../../ui";

/** The prompting guides, one per model family, folded; each opens to its text. */
function Guides({ own, onSave }: { own: Record<string, string>; onSave(id: string, text: string): Promise<unknown> }) {
  const guides = useQuery({ queryKey: ["designer-guides"], queryFn: api.designerGuides, staleTime: 60_000 });
  const [open, setOpen] = useState<string | null>(null);
  if (guides.isError) return <ErrorNote>{guides.error.message}</ErrorNote>;
  return (
    <div className="flex flex-col gap-2">
      {(guides.data?.items ?? []).map((g) => (
        <GuideEditor key={g.id} guide={g} own={own[g.id] ?? ""} open={open === g.id} onOpen={() => setOpen(open === g.id ? null : g.id)} onSave={(text) => onSave(g.id, text)} />
      ))}
    </div>
  );
}

/** One family's guide: the built-in text to read, or yours in its place. */
function GuideEditor({ guide, own, open, onOpen, onSave }: {
  guide: { id: string; name: string; style: string; guide: string };
  own: string;
  open: boolean;
  onOpen(): void;
  onSave(text: string): Promise<unknown>;
}) {
  const [text, setText] = useState(own || guide.guide);
  useEffect(() => setText(own || guide.guide), [own, guide.guide]);
  const yours = own.trim().length > 0;
  const dirty = text !== (own || guide.guide);
  const save = useMutation({ mutationFn: (t: string) => onSave(t) });
  return (
    <div className="rounded-lg border border-line">
      <button type="button" aria-expanded={open} onClick={onOpen} className="flex h-10 w-full items-center gap-2 px-3 text-left hover:bg-hover">
        <span className="font-semibold">{guide.name}</span>
        <span className="text-xs text-ink-3">{guide.style === "tags" ? "tags" : "sentences"} · {guide.guide.split(/\s+/).length} words</span>
        {yours && <span className="rounded bg-accent-wash px-1.5 py-px text-[10px] font-semibold text-accent">yours</span>}
        <span className="grow" />
        <span className="text-xs text-ink-2">{open ? "Close" : yours ? "Read or change" : "Read"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line p-3">
          <AutoText
            aria-label={`Prompting guide for ${guide.name}`}
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-lg border border-line bg-raised px-3 py-2.5 font-mono text-xs leading-normal"
          />
          <div className="flex flex-wrap items-center gap-2">
            {dirty && <Button size="sm" tone="primary" disabled={save.isPending || !text.trim()} onClick={() => save.mutate(text.trim() === guide.guide.trim() ? "" : text)}>Save as my guide for {guide.name}</Button>}
            {(yours || dirty) && <Button size="sm" tone="quiet" disabled={save.isPending} onClick={() => { setText(guide.guide); if (yours) save.mutate(""); }}>Reset to built-in</Button>}
            <span className="text-xs text-ink-3">{yours ? "The designer is given your text for this family." : "The built-in text. Change it and save: yours replaces it for this family only."}</span>
          </div>
          {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
        </div>
      )}
    </div>
  );
}

/** How prompts are written for each model: the prompting guides the designer is handed (and anyone can read). */
export function PromptsCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const put = async (patch: Record<string, unknown>) => client.setQueryData(["settings"], await api.saveSettings(patch));
  const s = settings.data;
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">Prompts</h2>
      <h3 className="font-bold">Prompting guides</h3>
      <div className="text-ink-2">
        How each model family's prompts are written, as the designer is told first: the rules of the model's own guide, and one example of the form. Change a family's text and yours replaces the built-in one for that family; the eye in the designer panel shows the whole system prompt as it is sent.
      </div>
      <Guides own={s?.designerGuides ?? {}} onSave={(id, text) => put({ designerGuides: { ...(s?.designerGuides ?? {}), [id]: text } })} />

    </section>
  );
}

/** Help while a prompt is written. */
export function WritingCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const save = useMutation({ mutationFn: api.saveSettings, onSuccess: (saved) => client.setQueryData(["settings"], saved) });
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">Prompts</h2>
      <Toggle on={settings.data?.tagCheck ?? true} onChange={(v) => save.mutate({ tagCheck: v })} label="Check tags against the danbooru tag list" />
      <div className="text-xs text-ink-3">
        For tag prompts (SDXL: Illustrious, NoobAI, Pony). Anime models learned danbooru's tags: another word does little, a typo nothing. One line under the prompt says how many tags are not on the list and opens the fixes; what the designer writes is put right the same way. The list is a file of Afflatus's: nothing is sent anywhere.
      </div>
      <div className="text-xs text-ink-3">
        In every prompt: <span className="font-mono text-ink-2">{"{red|black|white}"}</span> is a wildcard that picks one of the choices for each output, and Ctrl + ↑ or ↓ changes the weight of the tag the cursor is in (not for MiniMax H3, which has no prompt weights).
      </div>
      {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
    </section>
  );
}
