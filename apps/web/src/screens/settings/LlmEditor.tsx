import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type LlmInfo } from "../../api";
import { Button, Chip, cx, ErrorNote, fieldClass, NumberBox, Toggle } from "../../ui";
import { Block, Row } from "./Rows";

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
    <div className={cx("flex flex-col", inUse && !only && "shadow-[inset_3px_0_0_var(--color-accent)]")}>
      <div className="flex min-h-[52px] items-center gap-2 px-[18px] py-2">
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
        // the LLM's settings, one row each, on a darker ground under its line
        <div className="flex flex-col divide-y divide-line/60 border-t border-line bg-raised/40">
          <Row label="Name" sub="optional">
            <input aria-label="Your name for it" value={form.name} placeholder="Local Qwen, the fast one…" onChange={(e) => setForm({ ...form, name: e.target.value })} className={cx(field, "grow font-sans text-sm")} />
          </Row>
          <Row label="Base URL" help="The OpenAI-compatible endpoint, /v1 included. Ollama and LM Studio fill in their usual local address.">
            <input aria-label="Base URL" value={form.baseUrl} placeholder="http://127.0.0.1:1234/v1" spellCheck={false} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} className={cx(field, "grow")} />
            <button type="button" data-tip="Ollama serves the OpenAI format at this address on the computer it runs on. Then the model name as `ollama list` shows it." onClick={() => setForm({ ...form, baseUrl: "http://127.0.0.1:11434/v1", name: form.name || "Ollama" })} className="rounded-md border border-line-strong px-2 h-7 text-[11px] font-semibold text-ink-2 hover:bg-hover hover:text-ink">Ollama</button>
            <button type="button" data-tip="LM Studio's local server, at its usual address. Then the model name as its server page shows it." onClick={() => setForm({ ...form, baseUrl: "http://127.0.0.1:1234/v1", name: form.name || "LM Studio" })} className="rounded-md border border-line-strong px-2 h-7 text-[11px] font-semibold text-ink-2 hover:bg-hover hover:text-ink">LM Studio</button>
          </Row>
          <Row label="Model name">
            <input aria-label="Model name" value={form.model} placeholder="as /v1/models lists it" spellCheck={false} onChange={(e) => setForm({ ...form, model: e.target.value })} className={cx(field, "grow")} />
          </Row>
          <Row label="API key" sub={llm.hasApiKey ? "one is saved" : "if it asks for one"}>
            <input type="password" aria-label="API key" value={form.apiKey} placeholder={llm.hasApiKey ? "leave empty to keep it" : "none"} autoComplete="off" onChange={(e) => setForm({ ...form, apiKey: e.target.value })} className={cx(field, "grow")} />
          </Row>
          <Row label="Context size" help="How much the model can read at once. A long conversation is cut to what fits, oldest part first.">
            <NumberBox label="Context size, in tokens" value={form.contextSize} min={2048} max={2000000} unit="tokens" onCommit={(v) => setForm({ ...form, contextSize: v })} className="[&_input]:w-24" />
          </Row>
          <Row label="Max output tokens" help="The longest answer it may write. A model that thinks before it answers spends these on thinking too: give it more.">
            <NumberBox label="Max output tokens" value={form.maxOutputTokens} min={256} max={65536} unit="tokens" onCommit={(v) => setForm({ ...form, maxOutputTokens: v })} className="[&_input]:w-24" />
          </Row>
          <Row label="Vision (reads images)" help={form.vision ? "The designer is shown the image a form opens on before it writes. Turn this off if the model answers with an error about images." : "Off: it works from your text only, and says so."}>
            <Toggle bare on={form.vision} onChange={(on) => setForm({ ...form, vision: on })} label="Vision (reads images)" />
          </Row>
          <Row label="No thinking" help={form.noThinking ? "It is asked to answer without thinking first (enable_thinking=false for llama.cpp, vLLM and SGLang; think=false for Ollama): faster, and the output tokens all go to the answer. A server that rejects fields it does not know will answer with an error: turn this off there." : "Off: a model that thinks before it answers is left to. Test it to see whether it does."}>
            <Toggle bare on={form.noThinking} onChange={(on) => setForm({ ...form, noThinking: on })} label="No thinking" />
          </Row>
          <Row label="Test" help="Asks it a short question (with Vision on, also the colour of a small red picture). Saves first when something changed.">
            <Button tone="quiet" onClick={onRemove}>Remove</Button>
            <Button tone={dirty ? "primary" : "plain"} onClick={() => test.mutate()} disabled={test.isPending || !usable}>{test.isPending ? "Asking…" : dirty ? "Save and test" : "Test it"}</Button>
          </Row>
          {(test.isSuccess || test.isError) && (
            <Block>
              {test.isSuccess && (
                <span className="text-ink-2">
                  It answered "{test.data.answer}" in {(test.data.ms / 1000).toFixed(1)} s{test.data.thinks ? ", thinking first" : ""}
                  {test.data.vision && (test.data.vision.ok ? " · it read the picture" : ` · it did not name the red picture's colour (it said "${test.data.vision.answer}"): turn Vision off, or pick a model that reads images`)}
                </span>
              )}
              {test.isError && <ErrorNote>{test.error.message}</ErrorNote>}
            </Block>
          )}
        </div>
      )}
    </div>
  );
}
