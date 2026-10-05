import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type LlmInfo, type Settings } from "../../api";
import { useSettings } from "../../data";
import { AutoText, Button, cx, ErrorNote, NumberBox, Toggle, TwoStep } from "../../ui";

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

/** Instructions of your own for the designer, under a name. */
function InstructionEditor({ item, fresh, inUse, open, onOpen, onSave, onRemove }: {
  item: Settings["designerInstructions"][number];
  fresh: boolean;
  /** Picked as the usual one in the designer's panel. */
  inUse: boolean;
  open: boolean;
  onOpen(): void;
  onSave(next: Settings["designerInstructions"][number]): Promise<unknown>;
  onRemove(): void;
}) {
  const [name, setName] = useState(item.name);
  const [text, setText] = useState(item.text);
  const dirty = fresh || name !== item.name || text !== item.text;
  const save = useMutation({ mutationFn: () => onSave({ id: item.id, name: name.trim(), text }) });
  const firstLine = item.text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  if (!open && !fresh) {
    return (
      <button type="button" aria-expanded={false} onClick={onOpen} className="flex h-10 w-full items-center gap-2 rounded-lg border border-line px-3 text-left hover:bg-hover">
        <span className="shrink-0 font-semibold">{item.name || "Unnamed"}</span>
        {inUse && <span className="shrink-0 rounded bg-accent-wash px-1.5 py-px text-[10px] font-semibold text-accent">in use</span>}
        <span className="min-w-0 grow truncate text-xs text-ink-3">{firstLine}</span>
        <span className="shrink-0 text-xs text-ink-2">{item.text.split(/\s+/).filter(Boolean).length} words · Read or change</span>
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <div className="flex items-center gap-2">
        <input aria-label="Name of this system prompt" value={name} placeholder="A name: Photographer, Anime, Explicit…" onChange={(e) => setName(e.target.value)} className="h-9 min-w-0 grow rounded-lg border border-line bg-raised px-3 font-semibold placeholder:font-normal placeholder:text-ink-3" />
        {inUse && <span className="shrink-0 rounded bg-accent-wash px-1.5 py-px text-[10px] font-semibold text-accent">in use</span>}
        {dirty && <Button size="sm" tone="primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>Save</Button>}
        <Button size="sm" tone="quiet" onClick={onRemove}>Remove</Button>
        {!fresh && <Button size="sm" tone="quiet" onClick={onOpen}>Close</Button>}
      </div>
      <AutoText
        aria-label="System prompt text"
        rows={4}
        value={text}
        placeholder="What the designer should always do when this is picked, beyond the model's guide. For example: keep every prompt under 60 words; write the spoken lines in French; describe clothes down to the fabric; never soften explicit content."
        onChange={(e) => setText(e.target.value)}
        className="w-full rounded-lg border border-line bg-raised px-3 py-2.5 leading-normal placeholder:text-ink-3"
      />
      {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
    </div>
  );
}

/** The designer: the language models it can write with, your own instructions for it, and a fresh start. */
export function DesignerCard() {
  const settings = useSettings();
  const client = useQueryClient();
  // ones added here and not saved yet
  const [newLlms, setNewLlms] = useState<LlmInfo[]>([]);
  const [newNotes, setNewNotes] = useState<Settings["designerInstructions"]>([]);
  /** The system prompt open for reading or changing; the rest are folded to a line. */
  const [openNote, setOpenNote] = useState<string | null>(null);
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
      <div className="text-ink-2">
        Standing instructions of your own, each under a name, picked in the designer's panel for a draft or a clip; the one picked holds for every answer of that conversation. They are added after the model's prompting guide (Settings → Prompts) and WIN over it: an instruction that says "always name the focal length" brings the lens back into every prompt, which the guides now avoid unless the picture calls for it. Say what the guide cannot know: your taste, your subject matter, your limits.
      </div>
      {notes.map((n) => (
        <InstructionEditor
          key={n.id}
          item={n}
          fresh={false}
          inUse={s?.designerInstruction === n.id}
          open={openNote === n.id}
          onOpen={() => setOpenNote(openNote === n.id ? null : n.id)}
          onSave={(next) => put({ designerInstructions: notes.map((x) => (x.id === n.id ? next : x)) })}
          onRemove={() => change.mutate({ designerInstructions: notes.filter((x) => x.id !== n.id) })}
        />
      ))}
      {newNotes.map((n) => (
        <InstructionEditor
          key={n.id}
          item={n}
          fresh
          inUse={false}
          open
          onOpen={() => {}}
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

      <h3 className="mt-2 font-bold">Conversation history</h3>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5">
        <span className="min-w-0 grow basis-64 text-ink-2">
          {forget.isSuccess
            ? `Cleared: ${forget.data.forgotten} conversation${forget.data.forgotten === 1 ? "" : "s"}.`
            : "Clear every conversation with the designer, in all drafts and on all timelines. What it wrote into your forms stays. One conversation is cleared with \"Start over\" in the designer's panel."}
        </span>
        <TwoStep label="Clear every conversation" title="Clear every conversation with the designer" yes="Clear all" busy={forget.isPending} onAsk={() => forget.reset()} onYes={() => forget.mutate()} />
      </div>
      {forget.isError && <ErrorNote>{forget.error.message}</ErrorNote>}
    </section>
  );
}
