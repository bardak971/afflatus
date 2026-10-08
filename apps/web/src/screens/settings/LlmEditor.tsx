import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type LlmInfo } from "../../api";
import { Button, Chip, cx, ErrorNote, fieldClass, NumberBox, Toggle } from "../../ui";

const field = `h-10 min-w-0 font-mono text-xs placeholder:font-sans ${fieldClass}`;

/** One language model: its address, name and key, how much it reads and writes, whether it reads pictures. */
export function LlmEditor({ llm, inUse, only, fresh, onSave, onUse, onRemove }: {
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
  const [form, setForm] = useState({ name: llm.name, baseUrl: llm.baseUrl, model: llm.model, apiKey: "", contextSize: llm.contextSize, maxOutputTokens: llm.maxOutputTokens, vision: llm.vision, noThinking: llm.noThinking });
  const [open, setOpen] = useState(fresh);
  const dirty = fresh || form.name !== llm.name || form.baseUrl !== llm.baseUrl || form.model !== llm.model || form.apiKey !== "" || form.contextSize !== llm.contextSize || form.maxOutputTokens !== llm.maxOutputTokens || form.vision !== llm.vision || form.noThinking !== llm.noThinking;
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
          ? <Chip tone="accent" tip="A new conversation with the designer starts with this one. Each conversation keeps the one it was given.">New conversations</Chip>
          : <Button size="sm" disabled={fresh} onClick={onUse} data-tip="New conversations with the designer start with this one">Start with this one</Button>)}
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
                  <button type="button" data-tip="Ollama serves the OpenAI format at this address on the computer it runs on. Then the model name as `ollama list` shows it." onClick={() => setForm({ ...form, baseUrl: "http://127.0.0.1:11434/v1", name: form.name || "Ollama" })} className="rounded border border-line-strong px-1.5 text-[11px] font-semibold text-ink-2 hover:bg-hover hover:text-ink">Ollama</button>
                  <button type="button" data-tip="LM Studio's local server, at its usual address. Then the model name as its server page shows it." onClick={() => setForm({ ...form, baseUrl: "http://127.0.0.1:1234/v1", name: form.name || "LM Studio" })} className="rounded border border-line-strong px-1.5 text-[11px] font-semibold text-ink-2 hover:bg-hover hover:text-ink">LM Studio</button>
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
          <Toggle
            on={form.noThinking}
            onChange={(on) => setForm({ ...form, noThinking: on })}
            label="No thinking"
            note={form.noThinking ? "It is asked to answer without thinking first (enable_thinking=false for llama.cpp, vLLM and SGLang; think=false for Ollama): faster, and the output tokens all go to the answer. A server that rejects fields it does not know will answer with an error: turn this off there." : "A model that thinks before it answers is left to. Test it to see whether it does."}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button tone={dirty ? "primary" : "plain"} onClick={() => test.mutate()} disabled={test.isPending || !usable}>{test.isPending ? "Asking…" : dirty ? "Save and test" : "Test it"}</Button>
            {test.isSuccess && (
              <span className="text-ink-2">
                It answered "{test.data.answer}" in {(test.data.ms / 1000).toFixed(1)} s{test.data.thinks ? ", thinking first" : ""}
                {test.data.vision && (test.data.vision.ok ? " · it read the picture" : ` · it did not name the red picture's colour (it said "${test.data.vision.answer}"): turn Vision off, or pick a model that reads images`)}
              </span>
            )}
            <span className="grow" />
            <Button tone="quiet" onClick={onRemove}>Remove</Button>
          </div>
          {test.isError && <ErrorNote>{test.error.message}</ErrorNote>}
        </>
      )}
    </div>
  );
}
