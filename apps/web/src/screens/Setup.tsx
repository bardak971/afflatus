import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "wouter";
import { ChevronDown, Search, X } from "lucide-react";
import { fuzzyScore } from "@afflatus/core";
import { api, type LlmInfo, type RecipeInfo, type Settings } from "../api";
import { useFamilies, useRecipes, useSettings, useSetup, useStorage } from "../data";
import { fileLabel, gb, problemSaid, size } from "../format";
import { allowNotifications, useNotify } from "../store";
import { DownloadRow, GetFile, useDownloads } from "../GetFile";
import { Select } from "../Select";
import { AppearanceCard } from "../theme/Appearance";
import { AutoText, Button, cx, ErrorNote, NumberBox, Segmented, Toggle } from "../ui";

/** Where the space goes, and the two ways to get some back. */
function StorageCard() {
  const storage = useStorage();
  const client = useQueryClient();
  const [emptying, setEmptying] = useState(false);
  const done = () => {
    void client.invalidateQueries({ queryKey: ["assets"] });
    void client.invalidateQueries({ queryKey: ["timelines"] });
  };
  const idle = useMutation({ mutationFn: api.binIdleTakes, onSuccess: done });
  const empty = useMutation({ mutationFn: api.emptyBin, onSuccess: done });
  const s = storage.data;
  const parts = s ? [
    { label: "Videos that play, or are in your library", bytes: s.videos, tone: "bg-accent" },
    { label: "Takes that never play", bytes: s.idleTakes.bytes, tone: "bg-warn" },
    { label: "Images", bytes: s.pictures, tone: "bg-picture" },
    { label: "Audio", bytes: s.sounds, tone: "bg-good" },
    { label: "Bin", bytes: s.bin.bytes, tone: "bg-ink-3" },
  ] : [];
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold">Storage</h2>
        {s && <span className="text-ink-2">{size(s.total)} used</span>}
      </div>
      {storage.isError && <ErrorNote>{storage.error.message}</ErrorNote>}
      {s && s.total > 0 && (
        <div className="flex h-2.5 overflow-hidden rounded-full bg-line">
          {parts.map((p) => <div key={p.label} className={p.tone} style={{ width: `${(p.bytes / s.total) * 100}%` }} />)}
        </div>
      )}
      {s && (
        <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1.5">
          {parts.map((p) => (
            <div key={p.label} className="contents">
              <span className={cx("h-2.5 w-2.5 rounded-sm", p.tone)} />
              <dt className="text-ink-2">{p.label}</dt>
              <dd className="font-mono">{size(p.bytes)}</dd>
            </div>
          ))}
        </dl>
      )}
      {s && s.idleTakes.count > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5">
          <span>{s.idleTakes.count} take{s.idleTakes.count > 1 ? "s are" : " is"} not the one that plays in {s.idleTakes.count > 1 ? "their" : "its"} clip.</span>
          <Button size="sm" disabled={idle.isPending} onClick={() => idle.mutate()}>Move {s.idleTakes.count > 1 ? "them" : "it"} to the bin · {size(s.idleTakes.bytes)}</Button>
        </div>
      )}
      {s && s.bin.count > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5">
          <span>Bin: {s.bin.count} thing{s.bin.count > 1 ? "s" : ""}, kept 7 days before {s.bin.count > 1 ? "they are" : "it is"} deleted.</span>
          {emptying ? (
            <span className="flex items-center gap-1.5">
              <span className="text-xs text-ink-2">This cannot be undone.</span>
              <Button size="sm" tone="danger" disabled={empty.isPending} onClick={() => { empty.mutate(); setEmptying(false); }}>Erase {size(s.bin.bytes)}</Button>
              <Button size="sm" tone="quiet" onClick={() => setEmptying(false)}>Cancel</Button>
            </span>
          ) : (
            <Button size="sm" onClick={() => setEmptying(true)}>Empty it now</Button>
          )}
        </div>
      )}
      {(idle.isError || empty.isError) && <ErrorNote>{(idle.error ?? empty.error)?.message}</ErrorNote>}
      <div className="text-xs text-ink-3">
        Outputs you do not keep go to the bin after 24 hours{s && s.unkept.count ? ` (${s.unkept.count} now, ${size(s.unkept.bytes)})` : ""}. What is on a timeline is always kept.
      </div>
      <RenderRecord />
    </section>
  );
}

const KEEP_FOR = [{ value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "365", label: "A year" }, { value: "0", label: "For good" }];

/** The record of render times (Queue, "Render times"): how long each render is kept one by one, how much room it takes, and a way to forget it. */
function RenderRecord() {
  const client = useQueryClient();
  const settings = useSettings();
  const record = useQuery({ queryKey: ["assets", "render-record-size"], queryFn: api.renderRecordSize });
  const [forgetting, setForgetting] = useState(false);
  const forget = useMutation({ mutationFn: api.clearRenderRecord, onSuccess: () => client.invalidateQueries({ queryKey: ["assets"] }) });
  const keep = useMutation({ mutationFn: (days: number) => api.saveSettings({ renderHistoryDays: days }), onSuccess: (saved) => client.setQueryData(["settings"], saved) });
  const r = record.data;
  const days = settings.data?.renderHistoryDays ?? 90;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          Render times{r ? `: ${r.renders} render${r.renders === 1 ? "" : "s"} one by one${r.days ? `, ${r.days} day${r.days === 1 ? "" : "s"} as figures` : ""} · ${size(r.bytes)}` : ""}
        </span>
        <div className="w-72"><Segmented label="How long each render is kept one by one" value={String(days)} options={KEEP_FOR} onChange={(v) => keep.mutate(Number(v))} /></div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
        <span>What the Queue's "Render times" and the estimates on the buttons are made from. Older renders are folded into one line per model and day, kept for good: the charts still reach back, the list does not.</span>
        {forgetting ? (
          <span className="flex items-center gap-1.5">
            <span className="text-ink-2">The estimates start again from nothing.</span>
            <Button size="sm" tone="danger" disabled={forget.isPending} onClick={() => { forget.mutate(); setForgetting(false); }}>Forget them</Button>
            <Button size="sm" tone="quiet" onClick={() => setForgetting(false)}>Cancel</Button>
          </span>
        ) : (
          <Button size="sm" onClick={() => setForgetting(true)} disabled={!r || (!r.renders && !r.days)}>Forget every render time</Button>
        )}
      </div>
      {(forget.isError || keep.isError) && <ErrorNote>{(forget.error ?? keep.error)?.message}</ErrorNote>}
    </div>
  );
}

const shortId = () => Math.random().toString(36).slice(2, 10);
const field = "h-10 min-w-0 rounded-lg border border-line bg-raised px-3 font-mono text-xs placeholder:font-sans placeholder:text-ink-3";

/** One language model: its address, name and key, how much it reads and writes, whether it reads pictures. */
function LlmEditor({ llm, inUse, only, fresh, onSave, onUse, onRemove }: {
  llm: LlmInfo;
  inUse: boolean;
  /** The only one: there is nothing to choose between. */
  only: boolean;
  /** Not saved yet. */
  fresh: boolean;
  /** Saves it; the key only when one was typed. */
  onSave(next: Omit<LlmInfo, "hasApiKey"> & { apiKey?: string }): Promise<unknown>;
  onUse(): void;
  onRemove(): void;
}) {
  const [form, setForm] = useState({ name: llm.name, baseUrl: llm.baseUrl, model: llm.model, apiKey: "", contextSize: llm.contextSize, maxOutputTokens: llm.maxOutputTokens, vision: llm.vision });
  const [open, setOpen] = useState(fresh);
  const dirty = fresh || form.name !== llm.name || form.baseUrl !== llm.baseUrl || form.model !== llm.model || form.apiKey !== "" || form.contextSize !== llm.contextSize || form.maxOutputTokens !== llm.maxOutputTokens || form.vision !== llm.vision;
  const save = async () => {
    const { apiKey, ...rest } = form;
    await onSave({ id: llm.id, ...rest, name: rest.name.trim(), baseUrl: rest.baseUrl.trim(), model: rest.model.trim(), ...(apiKey ? { apiKey } : {}) });
    setForm((f) => ({ ...f, apiKey: "" }));
  };
  const test = useMutation({
    mutationFn: async () => {
      if (dirty) await save();
      return api.designerTest(llm.id);
    },
  });
  const usable = Boolean(form.baseUrl.trim() && form.model.trim());
  return (
    <div className={cx("flex flex-col gap-3 rounded-lg border p-3", inUse && !only ? "border-accent/60" : "border-line")}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 grow flex-col text-left" aria-expanded={open}>
          <span className="truncate font-semibold">{form.name.trim() || form.model.trim() || "New LLM"}</span>
          <span className="truncate font-mono text-xs text-ink-2">{[form.name.trim() ? form.model : "", form.baseUrl].filter(Boolean).join(" · ") || "no base URL yet"}</span>
        </button>
        {test.isSuccess && !dirty && <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-good"><span className="h-2 w-2 rounded-full bg-good" /> Answering</span>}
        {!only && (inUse
          ? <span className="shrink-0 rounded-full bg-accent-wash px-2 py-0.5 text-xs font-semibold text-accent" title="A new conversation with the designer starts with this one. Each conversation keeps the one it was given.">New conversations</span>
          : <Button size="sm" disabled={fresh} onClick={onUse} title="New conversations with the designer start with this one">Start with this one</Button>)}
        <Button size="sm" tone="quiet" onClick={() => setOpen(!open)}>{open ? "Close" : "Change"}</Button>
      </div>
      {open && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-2">Your name for it (optional)</span>
              <input value={form.name} placeholder="Local Qwen, the fast one…" onChange={(e) => setForm({ ...form, name: e.target.value })} className={cx(field, "font-sans text-sm")} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="flex items-baseline justify-between text-xs text-ink-2">
                <span>Base URL</span>
                <span className="flex gap-1.5">
                  <button type="button" title="Ollama serves the OpenAI format at this address on the computer it runs on. Then the model name as `ollama list` shows it." onClick={() => setForm({ ...form, baseUrl: "http://127.0.0.1:11434/v1", name: form.name || "Ollama" })} className="rounded border border-line-strong px-1.5 text-[11px] font-semibold text-ink-2 hover:bg-hover hover:text-ink">Ollama</button>
                  <button type="button" title="LM Studio's local server, at its usual address. Then the model name as its server page shows it." onClick={() => setForm({ ...form, baseUrl: "http://127.0.0.1:1234/v1", name: form.name || "LM Studio" })} className="rounded border border-line-strong px-1.5 text-[11px] font-semibold text-ink-2 hover:bg-hover hover:text-ink">LM Studio</button>
                </span>
              </span>
              <input value={form.baseUrl} placeholder="http://127.0.0.1:1234/v1" spellCheck={false} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} className={field} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-2">Model name</span>
              <input value={form.model} placeholder="as /v1/models lists it" spellCheck={false} onChange={(e) => setForm({ ...form, model: e.target.value })} className={field} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-2">API key {llm.hasApiKey ? "(one is saved)" : "(if it asks for one)"}</span>
              <input type="password" value={form.apiKey} placeholder={llm.hasApiKey ? "leave empty to keep it" : "none"} autoComplete="off" onChange={(e) => setForm({ ...form, apiKey: e.target.value })} className={field} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-ink-2">Context size</span>
              <NumberBox label="Context size, in tokens" value={form.contextSize} min={2048} max={2000000} unit="tokens" onCommit={(v) => setForm({ ...form, contextSize: v })} className="[&_input]:w-24" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-ink-2">Max output tokens</span>
              <NumberBox label="Max output tokens" value={form.maxOutputTokens} min={256} max={65536} unit="tokens" onCommit={(v) => setForm({ ...form, maxOutputTokens: v })} className="[&_input]:w-24" />
            </div>
            <span className="text-xs text-ink-3">How much the model can read at once. A long conversation is cut to what fits, oldest part first.</span>
            <span className="text-xs text-ink-3">The longest answer it may write. A model that thinks before it answers spends these on thinking too: give it more.</span>
          </div>
          <Toggle
            on={form.vision}
            onChange={(on) => setForm({ ...form, vision: on })}
            label="Vision (reads images)"
            note={form.vision ? "The designer is shown the image a form opens on before it writes. Turn this off if the model answers with an error about images." : "It works from your text only, and says so."}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button tone={dirty ? "primary" : "plain"} onClick={() => test.mutate()} disabled={test.isPending || !usable}>{test.isPending ? "Asking…" : dirty ? "Save and test" : "Test it"}</Button>
            {test.isSuccess && <span className="text-ink-2">It answered: "{test.data.answer}"</span>}
            <span className="grow" />
            <Button tone="quiet" onClick={onRemove}>Remove</Button>
          </div>
          {test.isError && <ErrorNote>{test.error.message}</ErrorNote>}
        </>
      )}
    </div>
  );
}

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

/** Instructions of your own for the designer, under a name. */
function InstructionEditor({ item, fresh, onSave, onRemove }: {
  item: Settings["designerInstructions"][number];
  fresh: boolean;
  onSave(next: Settings["designerInstructions"][number]): Promise<unknown>;
  onRemove(): void;
}) {
  const [name, setName] = useState(item.name);
  const [text, setText] = useState(item.text);
  const dirty = fresh || name !== item.name || text !== item.text;
  const save = useMutation({ mutationFn: () => onSave({ id: item.id, name: name.trim(), text }) });
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <div className="flex items-center gap-2">
        <input aria-label="Name of this system prompt" value={name} placeholder="A name: Cinematic, Anime tags, Explicit…" onChange={(e) => setName(e.target.value)} className="h-9 min-w-0 grow rounded-lg border border-line bg-raised px-3 font-semibold placeholder:font-normal placeholder:text-ink-3" />
        {dirty && <Button size="sm" tone="primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>Save</Button>}
        <Button size="sm" tone="quiet" onClick={onRemove}>Remove</Button>
      </div>
      <AutoText
        aria-label="System prompt text"
        rows={3}
        value={text}
        placeholder="What the designer should always do when these are picked. For example: write like a film director, name the lens and the light; never soften or leave out explicit content; keep every prompt under 80 words."
        onChange={(e) => setText(e.target.value)}
        className="w-full rounded-lg border border-line bg-raised px-3 py-2.5 leading-normal placeholder:text-ink-3"
      />
      {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
    </div>
  );
}

/** The designer: the language models it can write with, your own instructions for it, and a fresh start. */
function DesignerCard() {
  const settings = useSettings();
  const client = useQueryClient();
  // ones added here and not saved yet
  const [newLlms, setNewLlms] = useState<LlmInfo[]>([]);
  const [newNotes, setNewNotes] = useState<Settings["designerInstructions"]>([]);
  const [forgetting, setForgetting] = useState(false);
  const put = async (patch: Record<string, unknown>) => client.setQueryData(["settings"], await api.saveSettings(patch));
  const change = useMutation({ mutationFn: put });
  const forget = useMutation({
    mutationFn: api.forgetConversations,
    onSuccess: () => {
      // every draft and timeline read before this still holds its conversation
      client.removeQueries({ queryKey: ["drafts"] });
      void client.invalidateQueries({ queryKey: ["timelines"] });
    },
  });
  const s = settings.data;
  const saved = s?.llms ?? [];
  const notes = s?.designerInstructions ?? [];
  /** What is sent for a model that is not being changed: everything but its key, which the server keeps. */
  const kept = ({ hasApiKey: _has, ...l }: LlmInfo) => l;
  const all = saved.length + newLlms.length;
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">Designer</h2>
      <div className="text-ink-2">It writes and improves your prompts with a language model (LLM): any with an OpenAI-compatible API, on your computer (LM Studio, Ollama, llama.cpp) or elsewhere. Without one, everything else works. With several, each conversation has its own: you pick it in the designer's panel, and it stays with that draft or clip.</div>
      {saved.map((l) => (
        <LlmEditor
          key={l.id}
          llm={l}
          fresh={false}
          only={all === 1}
          inUse={s?.designerLlm === l.id}
          onSave={(next) => put({ llms: saved.map((x) => (x.id === l.id ? next : kept(x))) })}
          onUse={() => change.mutate({ designerLlm: l.id })}
          onRemove={() => change.mutate({ llms: saved.filter((x) => x.id !== l.id).map(kept) })}
        />
      ))}
      {newLlms.map((l) => (
        <LlmEditor
          key={l.id}
          llm={l}
          fresh
          only={all === 1}
          inUse={false}
          onSave={async (next) => {
            await put({ llms: [...saved.map(kept), next] });
            setNewLlms((list) => list.filter((x) => x.id !== l.id));
          }}
          onUse={() => {}}
          onRemove={() => setNewLlms((list) => list.filter((x) => x.id !== l.id))}
        />
      ))}
      <div>
        <Button onClick={() => setNewLlms((list) => [...list, { id: shortId(), name: "", baseUrl: "", model: "", hasApiKey: false, vision: false, contextSize: 16384, maxOutputTokens: 3000 }])}>
          {all ? "Add another LLM" : "Add an LLM"}
        </Button>
      </div>

      <h3 className="mt-2 font-bold">System prompts</h3>
      <div className="text-ink-2">Standing instructions of your own (added to the designer's system prompt), each under a name: one for film-like realism, one for anime tags, one for explicit content, whatever you want it held to. You pick one in the designer's panel, for that draft or clip: it then holds for every answer of that conversation, on top of what the designer knows about the model you are writing for.</div>
      {notes.map((n) => (
        <InstructionEditor
          key={n.id}
          item={n}
          fresh={false}
          onSave={(next) => put({ designerInstructions: notes.map((x) => (x.id === n.id ? next : x)) })}
          onRemove={() => change.mutate({ designerInstructions: notes.filter((x) => x.id !== n.id) })}
        />
      ))}
      {newNotes.map((n) => (
        <InstructionEditor
          key={n.id}
          item={n}
          fresh
          onSave={async (next) => {
            await put({ designerInstructions: [...notes, next] });
            setNewNotes((list) => list.filter((x) => x.id !== n.id));
          }}
          onRemove={() => setNewNotes((list) => list.filter((x) => x.id !== n.id))}
        />
      ))}
      <div>
        <Button onClick={() => setNewNotes((list) => [...list, { id: shortId(), name: "", text: "" }])}>Add system prompt</Button>
      </div>
      {change.isError && <ErrorNote>{change.error.message}</ErrorNote>}

      <h3 className="mt-2 font-bold">Prompting guides</h3>
      <div className="text-ink-2">
        How each model family's prompts are written, as the designer is told first: the rules of the model's own guide, and one example of the form. Change a family's text and yours replaces the built-in one for that family; the eye in the designer panel shows the whole system prompt as it is sent.
      </div>
      <Guides own={s?.designerGuides ?? {}} onSave={(id, text) => put({ designerGuides: { ...(s?.designerGuides ?? {}), [id]: text } })} />

      <h3 className="mt-2 font-bold">Conversation history</h3>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5">
        <span className="min-w-0 grow basis-64 text-ink-2">
          {forget.isSuccess
            ? `Cleared: ${forget.data.forgotten} conversation${forget.data.forgotten === 1 ? "" : "s"}.`
            : "Clear every conversation with the designer, in all drafts and on all timelines. What it wrote into your forms stays. One conversation is cleared with \"Start over\" in the designer's panel."}
        </span>
        {forgetting ? (
          <span className="flex items-center gap-1.5">
            <Button size="sm" tone="danger" disabled={forget.isPending} onClick={() => { forget.mutate(); setForgetting(false); }}>Clear all</Button>
            <Button size="sm" tone="quiet" onClick={() => setForgetting(false)}>Cancel</Button>
          </span>
        ) : (
          <Button size="sm" onClick={() => { forget.reset(); setForgetting(true); }}>Clear every conversation</Button>
        )}
      </div>
      {forget.isError && <ErrorNote>{forget.error.message}</ErrorNote>}
    </section>
  );
}

/** Whether Afflatus may ask Civitai where a missing file can be had. Off unless turned on here. */
function CivitaiCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.saveSettings(patch),
    onSuccess: () => {
      setKey("");
      // whether ComfyUI-Manager is there is only asked once downloading is turned on
      void client.invalidateQueries({ queryKey: ["downloads"] });
      return client.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  const on = Boolean(settings.data?.civitaiLookups);
  const fetching = Boolean(settings.data?.downloadModels);
  const downloads = useDownloads();
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">Missing models</h2>
      <Toggle on={fetching} onChange={(v) => save.mutate({ downloadModels: v })} label="Download missing models into ComfyUI (ComfyUI-Manager)" />
      <div className="text-xs text-ink-3">
        {fetching
          ? "A missing model file gets a \"Download\" button: from the URL the workflow's author gave, or from Civitai once it is found there. ComfyUI-Manager saves it in the right models folder; the file passes through Afflatus, which shows the progress. Nothing is downloaded until you press the button."
          : "Off: Afflatus never asks ComfyUI to download anything. Missing models only get links to open in your browser."}
      </div>
      {fetching && downloads.data && (
        <div className={cx("text-xs", downloads.data.manager.found ? "text-good" : "text-warn-ink")}>
          {downloads.data.manager.found
            ? `ComfyUI-Manager ${downloads.data.manager.version ?? ""} found.`
            : "This needs ComfyUI-Manager in your ComfyUI, and it was not found (or ComfyUI is not answering)."}
        </div>
      )}
      {(downloads.data?.items.length ?? 0) > 0 && (
        <div className="flex flex-col gap-1.5">
          {downloads.data!.items.map((d) => <DownloadRow key={d.id} d={d} named />)}
        </div>
      )}
      <Toggle on={on} onChange={(v) => save.mutate({ civitaiLookups: v })} label="Search Hugging Face and Civitai for missing models" />
      <div className="text-xs text-ink-3">
        {on
          ? "When a model file is missing, \"Search\" asks Hugging Face for a file of exactly that name, and Civitai (civitai.com and civitai.red) for models with a close name. Only the filename is sent, and only when you press the button. What is found is shown with a link, and with a Download button when downloading is turned on above."
          : "Off: Afflatus never contacts Hugging Face or Civitai. Missing models still get links that open a search in your browser."}
      </div>
      {on && (
        <div className="flex items-end gap-2">
          <label className="flex min-w-0 grow flex-col gap-1.5">
            <span className="text-xs text-ink-2">Civitai API key {settings.data?.hasCivitaiKey ? "(one is saved)" : "(only needed for models hidden without an account)"}</span>
            <input type="password" value={key} autoComplete="off" placeholder={settings.data?.hasCivitaiKey ? "leave empty to keep it" : "none"} onChange={(e) => setKey(e.target.value)} className="h-10 min-w-0 rounded-lg border border-line bg-raised px-3 font-mono text-xs placeholder:font-sans placeholder:text-ink-3" />
          </label>
          <Button onClick={() => save.mutate({ civitaiKey: key })} disabled={!key || save.isPending}>Save</Button>
          {settings.data?.hasCivitaiKey && <Button onClick={() => save.mutate({ civitaiKey: "" })} disabled={save.isPending}>Remove key</Button>}
        </div>
      )}
      {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
    </section>
  );
}

/**
 * A model from a link: the address of a model's page on Civitai or of a file on Hugging Face is pasted,
 * what it leads to is shown (its files, their sizes, the folder it most likely belongs in), and the file
 * picked is fetched into ComfyUI like any other download.
 */
function LinkCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const [link, setLink] = useState("");
  const [file, setFile] = useState("");
  const [folder, setFolder] = useState("");
  const [saveAs, setSaveAs] = useState("");
  const look = useMutation({
    mutationFn: (address: string) => api.resolveLink(address),
    onSuccess: (found) => {
      // the largest file first: of the same model, it is the least compressed one
      const first = [...found.files].sort((a, b) => b.bytes - a.bytes)[0]!;
      setFile(first.name);
      setSaveAs(first.name);
      setFolder(found.folder && found.folders.includes(found.folder) ? found.folder : "");
    },
  });
  const found = look.data;
  const start = useMutation({
    mutationFn: () => {
      const page = { url: found!.page, title: found!.title };
      const name = saveAs.trim() || file;
      return found!.source === "civitai"
        ? api.startDownload({ file: name, folder, civitai: found!.version!, pick: file, page })
        : api.startDownload({ file: name, folder, url: found!.url!, page });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["downloads"] }),
  });
  if (!settings.data?.downloadModels) return null;
  const chosen = found?.files.find((f) => f.name === file);
  const already = found?.have[file];
  const field = "h-10 min-w-0 rounded-lg border border-line bg-raised px-3 text-xs placeholder:text-ink-3";
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">Download a model from a URL</h2>
      <div className="text-ink-2">Paste the URL of a model page on Civitai (civitai.com or civitai.red), or of a file on Hugging Face. Afflatus shows what it is and downloads the file you pick into the ComfyUI models folder you choose.</div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          start.reset();
          if (link.trim()) look.mutate(link.trim());
        }}
      >
        <input aria-label="Model URL" value={link} placeholder="https://civitai.com/models/…  or  https://huggingface.co/…/resolve/main/….safetensors" spellCheck={false} onChange={(e) => setLink(e.target.value)} className={cx(field, "grow font-mono")} />
        <Button type="submit" disabled={!link.trim() || look.isPending}>{look.isPending ? "Resolving…" : "Resolve"}</Button>
      </form>
      {look.isError && <ErrorNote>{look.error.message}</ErrorNote>}
      {found && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-line p-3">
          <div className="flex flex-col">
            <a href={found.page} target="_blank" rel="noreferrer" className="font-semibold break-words hover:underline">{found.title}</a>
            <span className="text-xs text-ink-2">{found.about}</span>
          </div>
          {(found.versions?.length ?? 0) > 1 && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-2">Version</span>
              <Select
                label="Version"
                value={String(found.version)}
                onChange={(id) => look.mutate(`${found.page.split("?")[0]}?modelVersionId=${id}`)}
                options={found.versions!.map((v) => ({ value: String(v.id), label: v.name }))}
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-2">File{found.files.length > 1 ? ` (${found.files.length} to choose from)` : ""}</span>
            <Select
              label="File"
              value={file}
              onChange={(name) => { setFile(name); setSaveAs(name); }}
              options={found.files.map((f) => ({ value: f.name, label: f.name, note: [f.note, f.bytes ? size(f.bytes) : ""].filter(Boolean).join(" · "), detail: found.have[f.name] ? `ComfyUI already has a file of this name, in ${found.have[f.name]}` : undefined }))}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs text-ink-2">Models folder</span>
              <Select label="The ComfyUI models folder it goes into" placeholder="Choose a folder" value={folder} onChange={setFolder} options={found.folders.map((f) => ({ value: f, label: f, note: f === found.folder ? "suggested" : undefined }))} />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs text-ink-2">Filename</span>
              <input aria-label="Filename it is saved under" value={saveAs} spellCheck={false} onChange={(e) => setSaveAs(e.target.value)} className={cx(field, "font-mono")} />
            </label>
          </div>
          {found.why && <div className="text-xs text-ink-2">{found.why}</div>}
          {already && <div className="text-xs text-warn-ink">ComfyUI already has a file called {file}, in {already}.</div>}
          <div className="flex flex-wrap items-center gap-3">
            <Button tone="primary" disabled={!folder || !file || start.isPending} onClick={() => start.mutate()}>
              {start.isPending ? "Starting…" : `Download into ComfyUI${chosen?.bytes ? ` · ${size(chosen.bytes)}` : ""}`}
            </Button>
            {start.isSuccess && <span className="text-ink-2">Started: it shows under "Missing models" above, and at the bottom of every screen.</span>}
          </div>
          {start.isError && <ErrorNote>{start.error.message}</ErrorNote>}
        </div>
      )}
    </section>
  );
}

/** Help while a prompt is written. */
function WritingCard() {
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

/** What this browser tells you about. */
function NotifyCard() {
  const notify = useNotify();
  const [refused, setRefused] = useState(false);
  const set = async (patch: { whenEmpty?: boolean; eachRender?: boolean }) => {
    if (Object.values(patch).some(Boolean) && !(await allowNotifications())) return setRefused(true);
    setRefused(false);
    notify.set(patch);
  };
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">Notifications</h2>
      <Toggle on={notify.eachRender} onChange={(on) => void set({ eachRender: on })} label="Notify when a render finishes" />
      <Toggle on={notify.whenEmpty} onChange={(on) => void set({ whenEmpty: on })} label="Notify when the queue is empty" />
      <div className="text-xs text-ink-3">
        {refused ? "Your browser does not allow notifications from this page. Allow them in its settings, next to the address." : "A notification from your browser, while a Afflatus tab is open in it. Nothing leaves your computer. This is set per browser."}
      </div>
    </section>
  );
}

/**
 * One switch per model: whether it is offered in the lists to choose from (the model list in Studio, a
 * clip's model on a timeline, the tools under a picture). Left alone a model follows its files; set by
 * hand it stays as set. Nothing made with a model that is off is touched.
 */
function ModelSwitches() {
  const recipes = useRecipes();
  const settings = useSettings();
  const setup = useSetup();
  const families = useFamilies();
  const [needs, setNeeds] = useState<string | null>(null);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (next: Record<string, boolean>) => api.saveSettings({ families: next }),
    onSuccess: (saved) => client.setQueryData(["settings"], saved),
  });
  if (!recipes.data || !settings.data) return null;
  const said = settings.data.families;
  const shown = recipes.data.families.filter((f) => recipes.data.recipes.some((r) => r.family === f.id));
  const names = new Set<string>();
  const twice = new Set(shown.map((f) => f.name).filter((n) => (names.has(n) ? true : (names.add(n), false))));
  return (
    <>
      <h2 className="text-[15px] font-bold">Models</h2>
      <div className="text-ink-2">Off: left out of the model lists. What you generated with it stays.</div>
      <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {shown.map((f) => {
          const mine = recipes.data.recipes.filter((r) => r.family === f.id);
          const found = families.found(f.id);
          const on = families.isOn(f.id);
          const byHand = f.id in said;
          const imported = f.id.startsWith("workflow-");
          const name = `${f.name}${imported && twice.has(f.name) ? " (your workflows)" : ""}`;
          // its files are not there: what it needs is said here, once, with the way to get each file
          const slots = found || imported ? [] : (setup.data?.families.find((x) => x.id === f.id)?.slots ?? []).filter((x) => !x.optional && !x.file);
          const open = needs === f.id;
          return (
            <div key={f.id} className="flex flex-col">
              <div className="flex h-11 items-center gap-3 px-3">
                <span className={cx("truncate font-semibold", !on && "text-ink-2")}>{name}</span>
                <span className="shrink-0 text-xs text-ink-3">{imported ? `${mine.length} workflow${mine.length > 1 ? "s" : ""}` : `${mine.length} operation${mine.length > 1 ? "s" : ""}`}</span>
                <span className="grow" />
                {!found && (slots.length ? (
                  <button type="button" aria-expanded={open} title="The model files it needs, and where to get them" onClick={() => setNeeds(open ? null : f.id)} className="flex shrink-0 items-center gap-1 text-xs font-semibold text-warn-ink hover:underline">
                    {slots.length} model file{slots.length > 1 ? "s" : ""} missing <ChevronDown size={13} className={cx("transition-transform", open && "rotate-180")} />
                  </button>
                ) : (
                  <span className="shrink-0 text-xs text-warn-ink">not ready</span>
                ))}
                {byHand && (
                  <button
                    type="button"
                    title="Set manually. Click to let it follow its model files again: on when they are in ComfyUI, off when they are not."
                    onClick={() => save.mutate(Object.fromEntries(Object.entries(said).filter(([id]) => id !== f.id)))}
                    className="shrink-0 rounded-md border border-line-strong px-1.5 py-0.5 text-[11px] font-semibold text-ink-2 hover:text-ink"
                  >
                    manual ×
                  </button>
                )}
                <Toggle bare on={on} onChange={(next) => save.mutate({ ...said, [f.id]: next })} label={`${name} in the model lists`} />
              </div>
              {open && slots.length > 0 && (
                <div className="flex flex-col gap-2 border-t border-line bg-raised px-3 py-2.5 text-xs text-ink-2">
                  {slots.map((x) => (
                    <div key={x.id}>
                      <span className="font-semibold text-ink">{x.label}</span>: {x.hint}
                      {x.get && <GetFile file={x.get.file} folder={x.folder} url={x.get.url} hints={[f.name]} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
    </>
  );
}

/** Afflatus's node pack (MiniMax H3 continued in the latent): written into ComfyUI's folder when it is known, loaded after a ComfyUI restart. */
function NodePackLine() {
  const settings = useSettings();
  const pack = useQuery({ queryKey: ["node-pack", settings.data?.comfyDir], queryFn: api.nodePack, enabled: Boolean(settings.data), staleTime: 30_000 });
  if (!pack.data) return null;
  const p = pack.data;
  return (
    <div className="text-xs text-ink-2">
      {p.loaded
        ? <>Afflatus's node pack is loaded in ComfyUI: MiniMax H3 clips on a timeline continue from the clip before's own latent.</>
        : p.written
          ? <span className="text-warn-ink">Afflatus's node pack was written to ComfyUI's custom_nodes folder: <span className="font-semibold">restart ComfyUI</span> to load it. It lets MiniMax H3 clips continue from the clip before's own latent (no jump at the join).</span>
          : <>With the folder set, Afflatus puts its node pack in ComfyUI's custom_nodes: MiniMax H3 clips then continue from the clip before's own latent, which keeps the motion, the look and the voice across the join.</>}
    </div>
  );
}

/** ComfyUI's address and folder, the test, and when its models are unloaded. */
function ComfyCard() {
  const settings = useSettings();
  const setup = useSetup();
  const client = useQueryClient();
  const [url, setUrl] = useState("");
  const [dir, setDir] = useState("");
  useEffect(() => {
    if (settings.data) {
      setUrl(settings.data.comfyUrl);
      setDir(settings.data.comfyDir);
    }
  }, [settings.data]);
  const saveDir = useMutation({
    mutationFn: () => api.saveSettings({ comfyDir: dir.trim() }),
    onSuccess: (saved) => client.setQueryData(["settings"], saved),
  });
  /** Save the address if it changed, then ask ComfyUI again. Only reads: nothing is queued or loaded. */
  const test = useMutation({
    mutationFn: async () => {
      if (url !== settings.data?.comfyUrl) await api.saveSettings({ comfyUrl: url });
      return api.setup(true);
    },
    onSuccess: (scan) => {
      client.setQueryData(["setup"], scan);
      void client.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  const comfy = setup.data?.comfy;
  return (
    <section id="comfyui" className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold">ComfyUI</h2>
        {comfy && (
          <span className={cx("flex items-center gap-1.5 font-semibold", comfy.online ? "text-good" : "text-warn-ink")}>
            <span className={cx("h-2 w-2 rounded-full", comfy.online ? "bg-good" : "bg-warn")} />
            {comfy.online ? "Connected" : "Not answering"}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="comfy-url" className="text-xs text-ink-2">ComfyUI URL</label>
        <div className="flex gap-2">
          <input
            id="comfy-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            className="h-10 min-w-0 grow rounded-lg border border-line bg-raised px-3 font-mono text-xs"
          />
          <Button onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? "Connecting…" : url !== settings.data?.comfyUrl ? "Save and test" : "Test again"}</Button>
        </div>
      </div>
      {test.isError && <ErrorNote>{test.error.message}</ErrorNote>}
      {comfy?.online === false && <ErrorNote>{comfy.error}</ErrorNote>}
      {comfy?.online && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ink-2">
          <dt>Version</dt><dd className="text-ink">{comfy.version}</dd>
          <dt>GPU</dt><dd className="text-ink">{comfy.device}</dd>
          <dt>VRAM</dt><dd className="text-ink">{gb(comfy.vramTotal)} ({gb(comfy.vramFree)} free)</dd>
          <dt>Node types</dt><dd className="text-ink">{comfy.nodes}</dd>
        </dl>
      )}
      <div className="text-xs text-ink-3">Testing only reads what ComfyUI has. It never starts a render or loads a model.</div>
      <div className="flex flex-col gap-1.5 border-t border-line pt-3">
        <label htmlFor="comfy-dir" className="text-xs text-ink-2">ComfyUI folder on this computer <span className="text-ink-3">(optional: the one with main.py; lets "Open in ComfyUI" show the workflow straight away)</span></label>
        <div className="flex gap-2">
          <input
            id="comfy-dir"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="D:\\ComfyUI  —  empty when ComfyUI runs elsewhere"
            spellCheck={false}
            className="h-10 min-w-0 grow rounded-lg border border-line bg-raised px-3 font-mono text-xs"
          />
          <Button onClick={() => saveDir.mutate()} disabled={saveDir.isPending || dir.trim() === (settings.data?.comfyDir ?? "")}>Save</Button>
        </div>
        {saveDir.isError && <ErrorNote>{saveDir.error.message}</ErrorNote>}
        <NodePackLine />
      </div>
      {settings.data && (
        <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
          <span className="min-w-0">
            Unload models after
            <span className="block text-xs text-ink-2">{settings.data.unloadAfterMinutes > 0 ? "minutes without a render: the VRAM is freed. The next render loads them again." : "0 = never: they stay loaded until something else needs the VRAM. \"Unload models\" in the Queue does it manually."}</span>
          </span>
          <NumberBox
            label="Minutes without a render before ComfyUI's models are unloaded"
            value={settings.data.unloadAfterMinutes}
            min={0}
            max={1440}
            unit="min"
            onCommit={(v) => void api.saveSettings({ unloadAfterMinutes: v }).then((saved) => client.setQueryData(["settings"], saved))}
          />
        </div>
      )}
    </section>
  );
}

/** One recipe: ready, or what it lacks and how to get it. */
/**
 * The family's files where more than one fits (two SeedVR2 models, two turbo LoRAs): which one is used,
 * chosen by hand or left to the patterns. Nothing shown for a family whose files are all one of a kind.
 */
function SlotChoices({ family }: { family: string }) {
  const setup = useSetup();
  const settings = useSettings();
  const client = useQueryClient();
  const slots = (setup.data?.families.find((f) => f.id === family)?.slots ?? []).filter((s) => s.choices.length > 1 || s.chosen);
  const save = useMutation({
    mutationFn: (v: { slot: string; file: string }) => {
      const all = { ...(settings.data?.slotFiles ?? {}) };
      const mine = { ...(all[family] ?? {}) };
      if (v.file) mine[v.slot] = v.file;
      else delete mine[v.slot];
      if (Object.keys(mine).length) all[family] = mine;
      else delete all[family];
      return api.saveSettings({ slotFiles: all });
    },
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ["settings"] }), client.invalidateQueries({ queryKey: ["setup"] })]),
  });
  if (!slots.length) return null;
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <span className="text-xs font-semibold">Files in use</span>
      <span className="text-xs text-ink-2">More than one file fits here. Left to itself, Afflatus takes the first its patterns name; pick another to use it everywhere this family does.</span>
      {slots.map((s) => (
        <div key={s.id} className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 flex-col"><span className="truncate text-xs font-semibold">{s.label}</span><span className="truncate text-xs text-ink-3">{s.folder}</span></span>
          <div className="w-80 shrink-0">
            <Select
              size="sm"
              label={`File used for ${s.label}`}
              value={s.chosen ? (s.file ?? "") : ""}
              onChange={(file) => save.mutate({ slot: s.id, file })}
              options={[{ value: "", label: s.auto ? `Automatic: ${fileLabel(s.auto)}` : "Automatic", note: "the first its patterns name" }, ...s.choices.map((f) => ({ value: f, label: fileLabel(f) }))]}
            />
          </div>
        </div>
      ))}
      {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
    </div>
  );
}

function ReadyRow({ r }: { r: RecipeInfo }) {
  const setup = useSetup();
  const recipes = useRecipes();
  const s = setup.data?.recipes.find((x) => x.id === r.id);
  const family = recipes.data?.families.find((f) => f.id === r.family);
  const problems = [
    ...(s?.missingNodes.length ? [`Missing custom nodes: ${s.missingNodes.join(", ")}`] : []),
    ...(s?.problems ?? []).map((p) => `${problemSaid(p)}${r.id.startsWith("workflow.") ? " Fix it in Workflows, with Edit." : ""}`),
    ...(s?.emptyInputs ?? []).map((id) => {
      const input = r.inputs.find((i) => i.id === id);
      return `ComfyUI has no model file for "${input?.label ?? id}"${input?.note ? ` (${input.note})` : ""}`;
    }),
  ];
  const find = (file: string) => encodeURIComponent(fileLabel(file));
  // the family's own files: the ones it cannot run without, and the ones only some of its options need
  const slots = setup.data?.families.find((f) => f.id === r.family)?.slots ?? [];
  const needed = slots.filter((x) => s?.missingSlots.includes(x.id));
  const extra = s?.ready ? slots.filter((x) => x.optional && !x.file && x.get) : [];
  return (
    <div className="flex flex-col gap-1 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">{r.title}</span>
        <span className={cx("shrink-0 text-xs font-semibold", s?.ready ? "text-good" : "text-warn-ink")}>{s ? (s.ready ? "Ready" : "Not ready") : "Unknown"}</span>
      </div>
      {problems.map((p) => <div key={p} className="text-warn-ink">{p}</div>)}
      {needed.map((x) => (
        <div key={x.id} className="text-warn-ink">
          <span className="font-semibold">{x.label}</span> is missing. {x.hint}
          {x.get && <GetFile file={x.get.file} folder={x.folder} url={x.get.url} hints={family?.name ? [family.name] : []} />}
        </div>
      ))}
      {extra.map((x) => (
        <div key={x.id} className="text-ink-2">
          <span className="mr-1.5 rounded bg-raised px-1.5 py-px text-[10px] font-bold tracking-wide text-ink-3 uppercase">optional</span>
          <span className="font-semibold">{x.label}</span> is not installed; the operation runs without it. {x.hint}
          {x.get && <GetFile file={x.get.file} folder={x.folder} url={x.get.url} hints={family?.name ? [family.name] : []} />}
        </div>
      ))}
      {(s?.missing ?? []).map(({ file, folder, url }) => (
        <div key={file} className="text-warn-ink">
          Your ComfyUI does not have <span className="font-semibold break-all">{fileLabel(file)}</span>. Search for it on{" "}
          <a className="font-semibold underline" href={`https://civitai.com/search/models?query=${find(file)}`} target="_blank" rel="noreferrer">Civitai</a> or{" "}
          <a className="font-semibold underline" href={`https://huggingface.co/models?search=${find(file)}`} target="_blank" rel="noreferrer">Hugging Face</a>
          {r.id.startsWith("workflow.") && <>, or pick another file for it: <Link href="/workflows" className="font-semibold underline">Workflows</Link>, then Edit</>}.
          <GetFile file={file} folder={folder} url={url} hints={family?.name ? [family.name] : []} />
        </div>
      ))}
      {s?.limitedBy.length ? <div className="text-ink-2">Some options are off, missing custom nodes: {s.limitedBy.join(", ")}</div> : null}
      {s?.ready && (
        <div className="text-xs text-ink-2">
          {Object.entries(s.options).map(([k, v]) => `${r.inputs.find((i) => i.id === k)?.label ?? k}: ${v.length}`).join(" · ")}
        </div>
      )}
    </div>
  );
}

/**
 * What is ready, by model family: one line per family that says how many of its operations can run,
 * open when something is missing, folded when all is well. Only the families that are on are listed.
 */
function ReadyList() {
  const setup = useSetup();
  const recipes = useRecipes();
  const families = useFamilies();
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const listed = (recipes.data?.recipes ?? []).filter((r) => families.isOn(r.family));
  const readyOf = (id: string) => setup.data?.recipes.find((x) => x.id === id)?.ready ?? false;
  const ready = listed.filter((r) => readyOf(r.id)).length;
  const groups = (recipes.data?.families ?? []).map((f) => ({ family: f, recipes: listed.filter((r) => r.family === f.id) })).filter((g) => g.recipes.length);
  return (
    <section id="ready" className="flex flex-col gap-2.5 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">What is ready</h2>
      {setup.isLoading && <div className="text-ink-2">Asking ComfyUI…</div>}
      {setup.isError && <ErrorNote>{setup.error.message}</ErrorNote>}
      {setup.data && <div className="text-ink-2">{ready} of {listed.length} operations ready. Models that are off are not listed.</div>}
      <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {groups.map(({ family, recipes: mine }) => {
          const good = mine.filter((r) => readyOf(r.id)).length;
          const all = good === mine.length;
          // a family with something missing starts open; one that is all ready starts folded
          const open = opened[family.id] ?? (setup.data ? !all : false);
          return (
            <div key={family.id} className="flex flex-col">
              <button type="button" aria-expanded={open} onClick={() => setOpened({ ...opened, [family.id]: !open })} className="flex h-11 items-center gap-3 px-3 text-left hover:bg-hover">
                <span className="truncate font-semibold">{family.name}</span>
                <span className="grow" />
                {(() => {
                  // files the family does not need, but some option of it would use: said as what they are
                  const extras = (setup.data?.families.find((x) => x.id === family.id)?.slots ?? []).filter((x) => x.optional && !x.file && x.get).length;
                  return (
                    <span className="flex shrink-0 items-baseline gap-2 text-xs">
                      {setup.data && all && extras > 0 && <span className="text-ink-3">{extras} optional file{extras > 1 ? "s" : ""} to add</span>}
                      <span className={cx("font-semibold", !setup.data ? "text-ink-3" : all ? "text-good" : "text-warn-ink")}>{setup.data ? (all ? `${mine.length} ready` : `${good} of ${mine.length} ready`) : `${mine.length} operation${mine.length > 1 ? "s" : ""}`}</span>
                    </span>
                  );
                })()}
                <ChevronDown size={14} className={cx("shrink-0 text-ink-2 transition-transform", open && "rotate-180")} />
              </button>
              {open && (
                <div className="flex flex-col divide-y divide-line border-t border-line bg-raised">
                  <SlotChoices family={family.id} />
                  {mine.map((r) => <ReadyRow key={r.id} r={r} />)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The app itself: its version, where it runs, what it talks to. */
function AboutCard() {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: Infinity });
  const setup = useSetup();
  const comfy = setup.data?.comfy;
  return (
    <section id="about" className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">About</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ink-2">
        <dt>Afflatus</dt><dd className="text-ink">{health.data ? `version ${health.data.version}` : "…"}</dd>
        <dt>Database</dt><dd className="text-ink">{health.data?.database ?? "…"}</dd>
        <dt>ComfyUI</dt><dd className="text-ink">{comfy?.online ? `${comfy.version} · ${comfy.nodes} node types · ${comfy.device}` : comfy ? "not answering" : "…"}</dd>
        <dt>License</dt><dd className="text-ink">AGPL-3.0</dd>
        <dt>Source</dt><dd><a className="font-semibold text-ink underline" href="https://github.com/bardak971/afflatus" target="_blank" rel="noreferrer">github.com/bardak971/afflatus</a></dd>
      </dl>
      <div className="text-xs text-ink-3">Afflatus runs in front of your own ComfyUI. Nothing leaves your computer unless you ask for a download or a lookup.</div>
    </section>
  );
}

const TABS = [
  { id: "comfyui", label: "ComfyUI" },
  { id: "models", label: "Models" },
  { id: "designer", label: "Designer" },
  { id: "prompts", label: "Prompts" },
  { id: "appearance", label: "Appearance" },
  { id: "storage", label: "Storage" },
  { id: "notifications", label: "Notifications" },
  { id: "about", label: "About" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** Every setting, by the words someone would look for: what the search box finds, and the tab it is on. */
const INDEX: Array<{ tab: Tab; label: string; words?: string }> = [
  { tab: "comfyui", label: "ComfyUI URL", words: "address connection test port 8188" },
  { tab: "comfyui", label: "ComfyUI folder on this computer", words: "open in comfyui directory main.py" },
  { tab: "comfyui", label: "Unload models after N minutes", words: "vram free idle" },
  { tab: "models", label: "Models on or off in the lists", words: "families switch hide" },
  { tab: "models", label: "What is ready", words: "missing files nodes operations" },
  { tab: "models", label: "Civitai API key", words: "token" },
  { tab: "models", label: "Civitai lookups", words: "trigger words model pages lora names" },
  { tab: "models", label: "Download missing files into ComfyUI", words: "manager" },
  { tab: "models", label: "Download a model from a URL", words: "link hugging face civitai get" },
  { tab: "designer", label: "LLMs", words: "language model base url api key vision openai" },
  { tab: "designer", label: "System prompts", words: "instructions designer" },
  { tab: "designer", label: "Context size and max output tokens", words: "thinking" },
  { tab: "designer", label: "Forget every conversation", words: "chat history" },
  { tab: "prompts", label: "Danbooru tag check", words: "typo tags" },
  { tab: "appearance", label: "Theme", words: "dark light catppuccin rose pine system" },
  { tab: "appearance", label: "Accent colour", words: "color" },
  { tab: "appearance", label: "Explain every setting in the forms", words: "help tooltips" },
  { tab: "storage", label: "Disk usage", words: "space size" },
  { tab: "storage", label: "Empty the bin", words: "trash delete" },
  { tab: "storage", label: "Takes that never play", words: "idle" },
  { tab: "storage", label: "Render times kept for", words: "history retention days forget" },
  { tab: "notifications", label: "Notify when the queue is empty", words: "browser notification" },
  { tab: "notifications", label: "Notify after each render", words: "browser notification" },
  { tab: "about", label: "Version", words: "about license source github" },
];

/** Settings, in tabs: one for each thing being set up. The address carries the tab. */
export function Setup() {
  const params = useParams<{ tab?: string }>();
  const [, go] = useLocation();
  const tab: Tab = TABS.some((t) => t.id === params.tab) ? (params.tab as Tab) : "comfyui";
  const [typed, setTyped] = useState("");
  // each word typed is in the entry as typed, or as letters in order from the start of one of its words
  // ("civit" finds Civitai; "bin" does not find "github")
  const found = useMemo(() => {
    const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const matches = (text: string) => {
      const hay = text.toLowerCase();
      return words.every((w) => hay.includes(w) || hay.split(/[\s/,()-]+/).some((part) => part.startsWith(w[0]!) && fuzzyScore(w, part) !== null));
    };
    return INDEX.filter((i) => matches(`${i.label} ${i.words ?? ""} ${TABS.find((t) => t.id === i.tab)!.label}`)).slice(0, 8);
  }, [typed]);
  const open = (t: Tab) => {
    go(t === "comfyui" ? "/settings" : `/settings/${t}`);
    setTyped("");
  };
  return (
    <div className="flex min-h-0 grow flex-col overflow-hidden px-8 pb-6">
      <header className="flex h-20 shrink-0 items-center gap-5">
        <h1 className="text-xl font-semibold">Settings</h1>
        <div role="tablist" aria-label="Settings" className="flex shrink-0 gap-1 rounded-[9px] bg-raised p-[3px]">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === tab} onClick={() => open(t.id)} className={cx("h-7 rounded-md px-3 text-xs font-semibold whitespace-nowrap", t.id === tab ? "bg-line-strong text-ink-strong" : "text-ink-2 hover:text-ink")}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <div className="relative">
          <label className="flex h-9 w-64 items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent">
            <Search size={14} className="shrink-0 text-ink-3" />
            <input data-search aria-label="Find a setting" placeholder="Find a setting" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setTyped(""); if (e.key === "Enter" && found[0]) open(found[0].tab); }} className="min-w-0 grow bg-transparent placeholder:text-ink-3" />
            {typed && <button type="button" aria-label="Clear" onClick={() => setTyped("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
          </label>
          {typed.trim() && (
            <div role="listbox" aria-label="Settings found" className="absolute right-0 z-20 mt-1 flex w-80 flex-col overflow-hidden rounded-xl border border-line-strong bg-panel py-1 shadow-2xl shadow-shade/60">
              {found.length === 0 && <span className="px-3 py-2 text-xs text-ink-2">No setting matches “{typed}”.</span>}
              {found.map((f) => (
                <button key={`${f.tab}:${f.label}`} type="button" role="option" aria-selected={false} onClick={() => open(f.tab)} className="flex items-baseline gap-2 px-3 py-1.5 text-left hover:bg-hover">
                  <span className="min-w-0 grow truncate text-sm">{f.label}</span>
                  <span className="shrink-0 text-xs text-ink-3">{TABS.find((t) => t.id === f.tab)!.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <div className="min-h-0 grow overflow-y-auto pb-4">
        {tab === "comfyui" && <div className="max-w-[760px]"><ComfyCard /></div>}
        {tab === "models" && (
          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_440px]">
            <div className="flex flex-col gap-5">
              <section id="model-switches" className="flex flex-col gap-2.5 rounded-xl border border-line bg-panel p-[18px]"><ModelSwitches /></section>
              <ReadyList />
            </div>
            <div className="flex flex-col gap-5">
              <CivitaiCard />
              <LinkCard />
            </div>
          </div>
        )}
        {tab === "designer" && <div className="max-w-[900px]"><DesignerCard /></div>}
        {tab === "prompts" && <div className="max-w-[760px]"><WritingCard /></div>}
        {tab === "appearance" && <div className="max-w-[900px]"><AppearanceCard /></div>}
        {tab === "storage" && <div className="max-w-[760px]"><StorageCard /></div>}
        {tab === "notifications" && <div className="max-w-[760px]"><NotifyCard /></div>}
        {tab === "about" && <div className="max-w-[760px]"><AboutCard /></div>}
      </div>
    </div>
  );
}
