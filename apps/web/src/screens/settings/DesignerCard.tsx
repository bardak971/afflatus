import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type LlmInfo, type Settings } from "../../api";
import { useSettings } from "../../data";
import { AutoText, Button, cx, ErrorNote, fieldClass, Help, TwoStep } from "../../ui";
import { LlmEditor } from "./LlmEditor";
import { Block, Card, Row } from "./Rows";

const shortId = () => Math.random().toString(36).slice(2, 10);

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
      <button type="button" aria-expanded={false} onClick={onOpen} className="flex min-h-[52px] w-full items-center gap-2 px-[18px] text-left hover:bg-hover">
        <span className="shrink-0 font-semibold">{item.name || "Unnamed"}</span>
        {inUse && <span className="shrink-0 rounded bg-accent-wash px-1.5 py-px text-[10px] font-semibold text-accent">in use</span>}
        <span className="min-w-0 grow truncate text-xs text-ink-3">{firstLine}</span>
        <span className="shrink-0 text-xs text-ink-2">{item.text.split(/\s+/).filter(Boolean).length} words · Read or change</span>
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2 bg-raised/40 px-[18px] py-3">
      <div className="flex items-center gap-2">
        <input aria-label="Name of this system prompt" value={name} placeholder="A name: Photographer, Anime, Explicit…" onChange={(e) => setName(e.target.value)} className={cx("h-9 min-w-0 grow font-semibold placeholder:font-normal", fieldClass)} />
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
  const all = saved.length + newLlms.filter((n) => !saved.some((l) => l.id === n.id)).length;
  return (
    <div className="flex flex-col gap-4">
      <Card
        title={<span className="flex items-center gap-1.5">LLMs <Help title="LLMs" text="The designer writes and improves your prompts with a language model (LLM): any with an OpenAI-compatible API, on your computer (LM Studio, Ollama, llama.cpp) or elsewhere. Without one, everything else works. With several, each conversation has its own: you pick it in the designer's panel, and it stays with that draft or clip." /></span>}
        status={<span className="font-mono text-xs text-ink-3">{all || "none"}</span>}
      >
        {/* one list, keyed by id: a new one stays the same editor once saved, so "Save and test" shows its answer */}
        {[...saved, ...newLlms.filter((n) => !saved.some((l) => l.id === n.id))].map((l) => {
          const fresh = !saved.some((x) => x.id === l.id);
          return (
            <LlmEditor
              key={l.id}
              llm={l}
              fresh={fresh}
              only={all === 1}
              inUse={!fresh && s?.designerLlm === l.id}
              onSave={fresh
                ? async (next) => {
                  await put({ llms: [...saved.map(kept), next] });
                  setNewLlms((list) => list.filter((x) => x.id !== l.id));
                }
                : (next) => put({ llms: saved.map((x) => (x.id === l.id ? next : kept(x))) })}
              onUse={() => { if (!fresh) change.mutate({ designerLlm: l.id }); }}
              onRemove={() => (fresh ? setNewLlms((list) => list.filter((x) => x.id !== l.id)) : change.mutate({ llms: saved.filter((x) => x.id !== l.id).map(kept) }))}
            />
          );
        })}
        <Block>
          <div>
            <Button onClick={() => setNewLlms((list) => [...list, { id: shortId(), name: "", baseUrl: "", model: "", hasApiKey: false, vision: false, noThinking: false, contextSize: 16384, maxOutputTokens: 3000 }])}>
              {all ? "Add another LLM" : "Add an LLM"}
            </Button>
          </div>
        </Block>
      </Card>

      <Card
        title={<span className="flex items-center gap-1.5">System prompts <Help title="System prompts" text={`Standing instructions of your own, each under a name, picked in the designer's panel for a draft or a clip; the one picked holds for every answer of that conversation. They are added after the model's prompting guide (Settings › Prompts) and WIN over it: an instruction that says "always name the focal length" brings the lens back into every prompt, which the guides now avoid unless the picture calls for it. Say what the guide cannot know: your taste, your subject matter, your limits.`} /></span>}
        status={<span className="font-mono text-xs text-ink-3">{notes.length || "none"}</span>}
      >
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
        <Block>
          <div>
            <Button onClick={() => setNewNotes((list) => [...list, { id: shortId(), name: "", text: "" }])}>Add system prompt</Button>
          </div>
        </Block>
        {change.isError && <Block><ErrorNote>{change.error.message}</ErrorNote></Block>}
      </Card>

      <Card title="Conversation history">
        <Row
          label="Clear every conversation"
          sub={forget.isSuccess ? `Cleared: ${forget.data.forgotten} conversation${forget.data.forgotten === 1 ? "" : "s"}.` : undefined}
          help={`Clears every conversation with the designer, in all drafts and on all timelines. What it wrote into your forms stays. One conversation is cleared with "Start over" in the designer's panel.`}
        >
          <TwoStep label="Clear every conversation" title="Clear every conversation with the designer" yes="Clear all" busy={forget.isPending} onAsk={() => forget.reset()} onYes={() => forget.mutate()} />
        </Row>
        {forget.isError && <Block><ErrorNote>{forget.error.message}</ErrorNote></Block>}
      </Card>
    </div>
  );
}
