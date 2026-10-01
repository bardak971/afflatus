import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Check, Send, Sparkles, WandSparkles, X } from "lucide-react";
import { api, type DesignerReply, type Look, type RecipeInfo } from "./api";
import { useEntities, useSettings } from "./data";
import { Select } from "./Select";
import { AutoText, Button, cx, ErrorNote } from "./ui";

/** One thing said in the conversation. What the designer said keeps what it proposed, to use or not. */
export interface DesignerTurn {
  role: "user" | "assistant";
  content: string;
  reply?: DesignerReply;
  /** The proposal was put in the form. */
  used?: boolean;
}

/** What the designer said, as text again: the language model is shown its own earlier answers. */
const asText = (r: DesignerReply) =>
  [`kind: ${r.kind}`, `note: ${r.note}`, ...Object.entries(r.changes).map(([k, v]) => `${k}: ${v}`), r.question ? `question: ${r.question}` : ""].filter(Boolean).join("\n");

/**
 * The designer: a conversation that writes and improves what the form's text boxes hold. It opens on
 * demand, over the right side of the screen. What it proposes is shown whole and goes in the form only
 * when "Use it" is pressed.
 */
export function Designer({ recipe, values, onApply, turns, onTurns, previous, story, look, mood, onClose }: {
  recipe: RecipeInfo;
  /** The whole form as it is now. */
  values: Record<string, unknown>;
  onApply(changes: Record<string, string>): void;
  turns: DesignerTurn[];
  onTurns(turns: DesignerTurn[]): void;
  /** What the clip before says happens, when this one flows on from it. */
  previous?: string;
  /** The whole video the clip is part of: what every clip says happens, in order, and which one this is. */
  story?: { clips: string[]; index: number };
  look?: Look | null;
  mood?: string;
  onClose(): void;
}) {
  const settings = useSettings();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const boxes = recipe.inputs.filter((i) => i.type === "prompt");
  const ready = Boolean(settings.data?.llm.baseUrl && settings.data.llm.model);
  const say = useMutation({
    mutationFn: async (v: { words: string; mode: "chat" | "enhance" }) => {
      const mine: DesignerTurn[] = [...turns, { role: "user", content: v.words }];
      onTurns(mine);
      const reply = await api.designer({
        recipe: recipe.id, values, mode: v.mode, previous, story, look: look ?? null, mood,
        messages: mine.slice(-16).map((t) => ({ role: t.role, content: t.reply ? asText(t.reply) : t.content })),
      });
      onTurns([...mine, { role: "assistant", content: reply.note, reply }]);
    },
  });
  // in braces: a browser may hand back a promise from a scroll, and an effect must not return one
  useEffect(() => {
    void end.current?.scrollIntoView({ block: "end" });
  }, [turns.length, say.isPending]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const send = (words: string, mode: "chat" | "enhance" = "chat") => {
    if (!words.trim() || say.isPending) return;
    setText("");
    say.mutate({ words: words.trim(), mode });
  };
  const last = [...turns].reverse().find((t) => t.role === "assistant")?.reply;
  const sees = last?.sawPicture;

  return (
    <div role="dialog" aria-label="Designer" className="fixed top-0 right-0 bottom-10 z-30 flex w-[420px] flex-col border-l border-line-strong bg-panel shadow-2xl shadow-black/60">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <WandSparkles size={15} className="text-accent" />
        <span className="font-semibold">Designer</span>
        <span className="min-w-0 truncate text-xs text-ink-2">{story && story.clips.length > 1 ? `clip ${story.index + 1} of ${story.clips.length}: it knows the whole video · ` : ""}{sees === true ? "it has looked at your picture" : sees === false && values && recipe.inputs.some((i) => i.type === "image" && typeof values[i.id] === "string") ? "it works from your text only" : ""}</span>
        <span className="grow" />
        <button type="button" aria-label="Close the designer" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={15} /></button>
      </div>
      <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto p-4">
        {!ready && settings.isSuccess && (
          <ErrorNote>The designer has no language model yet. <Link href="/setup" className="font-semibold underline">Give it one in Setup</Link>: any address that speaks the OpenAI way works, on your computer or elsewhere.</ErrorNote>
        )}
        {!turns.length && ready && (
          <div className="text-ink-2">
            Say what you want in your own words: "a woman has coffee on a terrace at sunset", "make the light warmer", "longer and more detailed". The designer writes it the way {recipe.title.toLowerCase().includes("video") ? "this video model" : "this model"} reads best. Nothing changes in your form until you press "Use it".
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="max-w-[85%] self-end rounded-xl bg-hover px-3 py-2 whitespace-pre-wrap">{t.content}</div>
          ) : (
            <div key={i} className="flex flex-col gap-2 rounded-xl border border-line p-3">
              {t.reply?.kind === "question" ? <span className="font-semibold">{t.reply.question}</span> : null}
              {t.content && <span className={cx(t.reply?.kind === "question" && "text-ink-2")}>{t.content}</span>}
              {t.reply && Object.entries(t.reply.changes).map(([id, value]) => (
                <div key={id} className="flex flex-col gap-1">
                  <span className="text-xs font-semibold text-ink-2">{boxes.find((b) => b.id === id)?.label ?? id}</span>
                  <div className="rounded-lg bg-raised px-2.5 py-2 leading-normal break-words whitespace-pre-wrap">{value}</div>
                </div>
              ))}
              {t.reply && Object.keys(t.reply.changes).length > 0 && (
                <span>
                  {t.used ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-good"><Check size={13} /> In your form</span>
                  ) : (
                    <Button size="sm" tone="primary" onClick={() => { onApply(t.reply!.changes); onTurns(turns.map((x, j) => (j === i ? { ...x, used: true } : x))); }}>Use it</Button>
                  )}
                </span>
              )}
              {i === turns.length - 1 && t.reply && t.reply.options.length > 0 && (
                <span className="flex flex-wrap gap-1.5">
                  {t.reply.options.map((o) => <button key={o} type="button" onClick={() => send(o)} className="rounded-full border border-line-strong px-2.5 py-1 text-xs hover:bg-hover">{o}</button>)}
                </span>
              )}
            </div>
          ),
        )}
        {say.isPending && <div className="self-start rounded-xl border border-line px-3 py-2 text-ink-2">Writing…</div>}
        {say.isError && <ErrorNote>{say.error.message}</ErrorNote>}
        <div ref={end} />
      </div>
      <form
        className="flex shrink-0 flex-col gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <div className="flex flex-wrap gap-1.5">
          <button type="button" disabled={!ready || say.isPending} onClick={() => send("Improve it", "enhance")} className="flex items-center gap-1.5 rounded-full border border-line-strong px-2.5 py-1 text-xs hover:bg-hover disabled:opacity-45"><Sparkles size={12} /> Improve it</button>
          {["More detail", "Shorter"].map((o) => <button key={o} type="button" disabled={!ready || say.isPending} onClick={() => send(o)} className="rounded-full border border-line-strong px-2.5 py-1 text-xs hover:bg-hover disabled:opacity-45">{o}</button>)}
        </div>
        <div className="flex items-end gap-2">
          <AutoText
            aria-label="Tell the designer what to write or change"
            rows={1}
            value={text}
            placeholder="Tell the designer what to write or change"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
            className="min-h-10 w-full rounded-lg border border-line bg-raised px-3 py-2.5 placeholder:text-ink-3"
          />
          <Button type="submit" tone="primary" className="h-10 w-10 shrink-0 px-0" aria-label="Send" disabled={!ready || !text.trim() || say.isPending}><Send size={15} /></Button>
        </div>
      </form>
    </div>
  );
}

/**
 * The two helpers that sit above a form's text: the designer, and snippets (bits of text kept to drop
 * into what is written).
 */
export function WritingHelp({ recipe, text, onInsert, onDesigner }: {
  recipe: RecipeInfo;
  /** What the main text box holds now, to keep as a snippet. */
  text: string;
  onInsert(text: string): void;
  onDesigner(): void;
}) {
  const entities = useEntities();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const snippets = (entities.data?.items ?? []).filter((e) => e.kind === "snippet");
  const save = useMutation({ mutationFn: (n: string) => api.createEntity("snippet", n, { text }), onSuccess: () => client.invalidateQueries({ queryKey: ["entities"] }) });
  if (!recipe.inputs.some((i) => i.type === "prompt")) return null;
  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" onClick={onDesigner}><WandSparkles size={13} /> Ask the designer</Button>
      <div className="w-36">
        <Select
          dashed
          size="sm"
          icon={<Bookmark size={13} className="shrink-0" />}
          label="Snippets"
          placeholder="Snippets"
          searchHint="Search your snippets"
          value=""
          onChange={(id) => {
            const s = snippets.find((x) => x.id === id);
            if (s?.kind === "snippet") onInsert(s.def.text);
          }}
          options={snippets.map((s) => ({ value: s.id, label: s.name, detail: s.kind === "snippet" ? s.def.text : "" }))}
          footer={(close) => (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim() || !text.trim()) return;
                save.mutate(name.trim());
                setName("");
                close();
              }}
            >
              <input aria-label="Name of a new snippet" placeholder={text.trim() ? "Keep what is written as: a name" : "Write something first"} value={name} disabled={!text.trim()} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="h-8 min-w-0 grow rounded-md bg-raised px-2 placeholder:text-ink-3" />
              <Button size="sm" tone="quiet" type="submit" disabled={!name.trim() || !text.trim()}>Keep</Button>
            </form>
          )}
        />
      </div>
    </div>
  );
}
