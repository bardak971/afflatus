import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SettingsPatch } from "../../api";
import { useSettings } from "../../data";
import { AutoText, Button, Chip, Failed, Help, Toggle } from "../../ui";
import { Block, Card, Fact, Row } from "./Rows";
import { queryKeys } from "../../queryKeys";
import { SETTING_HELP } from "@afflatus/core";

/** The prompting guides, one per model family, folded; each opens to its text. */
function Guides({ own, onSave }: { own: Record<string, string>; onSave(id: string, text: string): Promise<unknown> }) {
  const guides = useQuery({ queryKey: queryKeys.designerGuides(), queryFn: api.designerGuides, staleTime: 60_000 });
  const [open, setOpen] = useState<string | null>(null);
  if (guides.isError) return <Block><Failed what="Guides not loaded" error={guides.error} /></Block>;
  return (
    <>
      {(guides.data?.items ?? []).map((g) => (
        // the guide of your workflows for a model shares its family's name: told apart as on the Models tab
        <GuideEditor key={g.id} guide={g.imported ? { ...g, name: `${g.name} (your workflows)` } : g}own={own[g.id] ?? ""} open={open === g.id} onOpen={() => setOpen(open === g.id ? null : g.id)} onSave={(text) => onSave(g.id, text)} />
      ))}
    </>
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
    <div>
      <button type="button" aria-expanded={open} onClick={onOpen} className="flex min-h-[52px] w-full items-center gap-2 px-gutter text-left hover:bg-hover">
        <span className="font-semibold">{guide.name}</span>
        <span className="text-xs text-ink-3">{guide.style === "tags" ? "tags" : "sentences"} · {guide.guide.split(/\s+/).length} words</span>
        {yours && <Chip size="xs" tone="accent">yours</Chip>}
        <span className="grow" />
        <span className="text-xs text-ink-2">{open ? "Close" : yours ? "Read or change" : "Read"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line bg-raised/40 px-gutter py-3">
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
            <span className="flex items-center gap-1.5 text-xs text-ink-3">
              {yours ? "yours" : "built-in"}
              <Help text={yours ? "The designer is given your text for this family." : "Change it and save: yours replaces the built-in text for this family only."} />
            </span>
          </div>
          {save.isError && <Failed what="Guide not saved" error={save.error} />}
        </div>
      )}
    </div>
  );
}

/** How prompts are written for each model: the prompting guides the designer is handed (and anyone can read). */
export function PromptsCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const put = async (patch: SettingsPatch) => client.setQueryData(queryKeys.settings(), await api.saveSettings(patch));
  const s = settings.data;
  return (
    <Card setting="prompts.guides" title={<span className="flex items-center gap-1.5">Prompting guides <Help title="Prompting guides" text={SETTING_HELP.designerGuides} /></span>}>
      <Guides own={s?.designerGuides ?? {}} onSave={(id, text) => put({ designerGuides: { ...(s?.designerGuides ?? {}), [id]: text } })} />
    </Card>
  );
}

/** Help while a prompt is written. */
export function WritingCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const save = useMutation({ mutationFn: api.saveSettings, onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved) });
  return (
    <Card title="Writing prompts">
      <Row setting="server.tagCheck" label="Danbooru tag check" help={SETTING_HELP.tagCheck}>
        <Toggle bare on={settings.data?.tagCheck ?? true} onChange={(v) => save.mutate({ tagCheck: v })} label="Check tags against the danbooru tag list" />
      </Row>
      <Row setting="prompts.wildcards" label="Wildcards and weights" help="In every prompt: {red|black|white} is a wildcard that picks one of the choices for each output, and Ctrl + ↑ or ↓ changes the weight of the tag the cursor is in (not for MiniMax H3, which has no prompt weights).">
        <Fact tip="A wildcard: one of the choices for each output">{"{red|black|white}"}</Fact>
        <Fact tip="Changes the weight of the tag the cursor is in">Ctrl + ↑ ↓</Fact>
      </Row>
      {save.isError && <Block><Failed what="Not saved" error={save.error} /></Block>}
    </Card>
  );
}
