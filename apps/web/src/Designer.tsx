import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw, RotateCcw, Send, Sparkles, TriangleAlert, Undo2, WandSparkles, X } from "lucide-react";
import { api, type DesignerReply, type DesignerSession, type Look, type RecipeInfo } from "./api";
import { useEntities, useSettings } from "./data";
import { changedShare, wordDiff } from "./diff";
import { Select } from "./Select";
import { mainTextOf } from "./RecipeForm";
import { Snippets, TickedSnippets } from "./Snippets";
import { AutoText, Button, cx, ErrorNote } from "./ui";

/** One thing said in the conversation. What the designer said keeps what it proposed, to use or not. */
export interface DesignerTurn {
  role: "user" | "assistant";
  content: string;
  reply?: DesignerReply;
  /** The proposal was put in the form. */
  used?: boolean;
  /** What the parts it changes held when it was proposed: to show what changed, and to put back. */
  was?: Record<string, string>;
}

/** What the designer said, as text again: the language model is shown its own earlier answers. */
const asText = (r: DesignerReply) =>
  [`kind: ${r.kind}`, `note: ${r.note}`, ...Object.entries(r.changes).map(([k, v]) => `${k}: ${v}`), r.question ? `question: ${r.question}` : ""].filter(Boolean).join("\n");

/**
 * The designer: a conversation that writes and improves what the form's text boxes hold. It opens on
 * demand, over the right side of the screen. It can be asked something and just answer; what it
 * proposes is shown with what changed marked, and goes in the form only when "Use it" is pressed.
 * A reply that claims a change and carries no text, or only a fragment, is said to be so.
 */
export function Designer({ recipe, values, onApply, turns, onTurns, session, onSession, previous, story, look, mood, onClose, side = "right" }: {
  recipe: RecipeInfo;
  /** The whole form as it is now. */
  values: Record<string, unknown>;
  onApply(changes: Record<string, string>): void;
  turns: DesignerTurn[];
  onTurns(turns: DesignerTurn[]): void;
  /** The language model and instructions this conversation is held with: its own, kept with the draft or the clip. */
  session: DesignerSession | null;
  onSession(session: DesignerSession): void;
  /** What the clip before says happens, when this one flows on from it. */
  previous?: string;
  /** The whole video the clip is part of: what every clip says happens, in order, and which one this is. */
  story?: { clips: string[]; index: number };
  look?: Look | null;
  mood?: string;
  onClose(): void;
  /** Which side of the screen it opens on: the one where it does not hide the form it writes into. */
  side?: "left" | "right";
}) {
  const settings = useSettings();
  const client = useQueryClient();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const boxes = recipe.inputs.filter((i) => i.type === "prompt");
  const ready = Boolean(settings.data?.llm.baseUrl && settings.data.llm.model);
  const say = useMutation({
    mutationFn: async (v: { words: string; mode: "chat" | "enhance"; from?: DesignerTurn[] }) => {
      // `from`: the conversation as it was before a reply that is asked for again
      const mine: DesignerTurn[] = [...(v.from ?? turns), { role: "user", content: v.words }];
      onTurns(mine);
      // a conversation keeps what it was started with, whatever is picked elsewhere afterwards
      if (!session) onSession(using);
      const reply = await api.designer({
        recipe: recipe.id, values, mode: v.mode, previous, story, look: look ?? null, mood, llm: using.llm, instruction: using.instruction,
        // the server keeps as much of it as the language model can read
        messages: mine.slice(-40).map((t) => ({ role: t.role, content: (t.reply ? asText(t.reply) : t.content).slice(0, 8000) })),
      });
      // what the parts it changes hold now is kept with the proposal: what changed is shown against it
      const was = Object.fromEntries(Object.keys(reply.changes).map((id) => [id, typeof values[id] === "string" ? (values[id] as string) : ""]));
      onTurns([...mine, { role: "assistant", content: reply.note, reply, ...(Object.keys(was).length ? { was } : {}) }]);
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
  // On the left it ends above what is marked `data-designer-floor` (the strip of clips), which stays in view.
  const [floor, setFloor] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (side !== "left") return;
    const el = document.querySelector("[data-designer-floor]");
    if (!el) return;
    const measure = () => setFloor(Math.max(0, window.innerHeight - el.getBoundingClientRect().top));
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      seen.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [side]);
  // A click anywhere else closes it, except in the form it writes into (marked `data-designer-stays`):
  // the texts are corrected by hand between two messages. Menus float outside the panel and are part of it.
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (!el?.closest || panel.current?.contains(el)) return;
      if (el.closest('[data-designer-stays], [data-floating], [role="menu"]')) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);
  const send = (words: string, mode: "chat" | "enhance" = "chat") => {
    if (!words.trim() || say.isPending) return;
    setText("");
    say.mutate({ words: words.trim(), mode });
  };
  const llms = settings.data?.llms ?? [];
  const instructions = settings.data?.designerInstructions ?? [];
  /**
   * What this conversation is held with: its own choice, else what the last choice made anywhere was
   * (a new conversation starts the way the last one was set up). One that is gone from Settings falls back.
   */
  const using: DesignerSession = {
    llm: llms.some((l) => l.id === session?.llm) ? session!.llm : settings.data?.designerLlm,
    instruction: session?.instruction !== undefined && (session.instruction === "" || instructions.some((i) => i.id === session.instruction)) ? session.instruction : settings.data?.designerInstruction ?? "",
  };
  /** A choice belongs to this conversation; it is also what the next new conversation starts with. */
  const remember = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.saveSettings(patch),
    onSuccess: (saved) => client.setQueryData(["settings"], saved),
  });
  const choose = (change: DesignerSession) => {
    onSession({ ...using, ...change });
    remember.mutate({ ...(change.llm !== undefined ? { designerLlm: change.llm } : {}), ...(change.instruction !== undefined ? { designerInstruction: change.instruction } : {}) });
  };
  const last = [...turns].reverse().find((t) => t.role === "assistant")?.reply;
  const sees = last?.sawPicture;
  // What it knows of the pictures and the clip the form holds, from how studai made them: asked for
  // when those change, not as the texts are typed.
  const media = JSON.stringify(recipe.inputs.filter((i) => i.type === "image" || i.type === "clip").map((i) => [i.id, values[i.id] ?? null]));
  const knows = useQuery({
    queryKey: ["designer-knows", recipe.id, media],
    queryFn: () => api.designerKnows(recipe.id, Object.fromEntries(JSON.parse(media) as Array<[string, unknown]>)),
    enabled: ready,
    staleTime: 60_000,
  });
  const video = recipe.output === "video";
  /** Ways to start that use what it knows: a first version from the picture's own story, or ideas to pick from. */
  const starts = [
    ...(knows.data?.continues ? ["Write what happens next", "Suggest three things that could happen next"] : []),
    ...(knows.data?.pictures.length && !knows.data.continues
      ? video ? ["Animate what the picture shows", "Suggest three things that could happen in it"] : ["Write it from what the picture shows", "Suggest three ways to change it"]
      : []),
  ];

  return (
    <div ref={panel} role="dialog" aria-label="Designer" style={floor !== null ? { bottom: floor } : undefined} className={cx("fixed top-0 bottom-10 z-30 flex w-[420px] flex-col border-line-strong bg-panel shadow-2xl shadow-shade/60", side === "left" ? "left-[76px] border-r" : "right-0 border-l")}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <WandSparkles size={15} className="text-accent" />
        <span className="font-semibold">Designer</span>
        <span className="min-w-0 truncate text-xs text-ink-2">{story && story.clips.length > 1 ? `clip ${story.index + 1} of ${story.clips.length}: it knows the whole video · ` : ""}{sees === true ? "it has looked at your image" : sees === false && values && recipe.inputs.some((i) => i.type === "image" && typeof values[i.id] === "string") ? "it works from your text only" : ""}</span>
        <span className="grow" />
        <button type="button" aria-label="Close the designer" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={15} /></button>
      </div>
      {ready && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2">
          <Select
            size="sm"
            className="min-w-0 grow basis-0"
            label="LLM"
            searchHint="Search your LLMs"
            value={using.llm ?? ""}
            onChange={(id) => choose({ llm: id })}
            options={llms.map((l) => ({ value: l.id, label: l.name || l.model, detail: `${l.name ? `${l.model} · ` : ""}${l.vision ? "vision · " : ""}${Math.round(l.contextSize / 1000)}k context` }))}
            footer={() => <Link href="/settings" className="text-xs text-ink-2 underline">Add or edit LLMs in Settings</Link>}
          />
          <Select
            size="sm"
            className="min-w-0 grow basis-0"
            label="System prompt"
            searchHint="Search your system prompts"
            value={using.instruction || "none"}
            onChange={(id) => choose({ instruction: id === "none" ? "" : id })}
            options={[{ value: "none", label: "No system prompt", detail: "The designer writes its usual way." }, ...instructions.map((i) => ({ value: i.id, label: i.name, detail: i.text.replace(/\s+/g, " ").slice(0, 160) }))]}
            footer={() => <Link href="/settings" className="text-xs text-ink-2 underline">Write your own system prompts in Settings</Link>}
          />
          <Button
            size="sm"
            tone="quiet"
            className="shrink-0"
            disabled={!turns.length || say.isPending}
            title="Clear this conversation and start again. What is in your form stays."
            onClick={() => { onTurns([]); say.reset(); }}
          >
            <RotateCcw size={13} /> Start over
          </Button>
        </div>
      )}
      <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto p-4">
        {remember.isError && <ErrorNote>{remember.error.message}</ErrorNote>}
        {!ready && settings.isSuccess && (
          <ErrorNote>The designer has no LLM yet. <Link href="/settings" className="font-semibold underline">Add one in Settings</Link>: any OpenAI-compatible API works, on your computer or elsewhere.</ErrorNote>
        )}
        {!turns.length && ready && (
          <div className="text-ink-2">
            Say what you want in your own words: "a woman has coffee on a terrace at sunset", "make the light warmer", "longer and more detailed". Or just ask: "what would make this more dramatic?", "give me three ideas for what she says". The designer writes it the way {recipe.title.toLowerCase().includes("video") ? "this video model" : "this model"} reads best. Nothing changes in your form until you press "Apply".
          </div>
        )}
        {!turns.length && ready && knows.data && (knows.data.pictures.length > 0 || knows.data.continues) && (
          <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
            <span className="text-xs font-semibold text-good">It knows the generation parameters</span>
            {knows.data.pictures.map((p) => (
              <span key={p.what} className="text-xs text-ink-2">
                <span className="text-ink">{p.what}</span>: {p.steps.map((x) => `${x.title}${x.with ? ` · ${x.with}` : ""}`).join(" → ")}. It is given {p.steps.filter((x) => x.said).length > 1 ? "the prompts" : "the prompt"} of {p.steps.filter((x) => x.said).length > 1 ? "those steps" : "that step"}.
              </span>
            ))}
            <span className="flex flex-wrap gap-1.5">
              {starts.map((o) => <button key={o} type="button" disabled={say.isPending} onClick={() => send(o)} className="rounded-full border border-line-strong px-2.5 py-1 text-left text-xs hover:bg-hover disabled:opacity-45">{o}</button>)}
            </span>
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="max-w-[85%] self-end rounded-xl bg-hover px-3 py-2 whitespace-pre-wrap">{t.content}</div>
          ) : (
            <Reply
              key={i}
              turn={t}
              last={i === turns.length - 1}
              busy={say.isPending}
              label={(id) => boxes.find((b) => b.id === id)?.label ?? id}
              onUse={() => { onApply(t.reply!.changes); onTurns(turns.map((x, j) => (j === i ? { ...x, used: true } : x))); }}
              onUndo={() => { if (t.was) onApply(t.was); onTurns(turns.map((x, j) => (j === i ? { ...x, used: false } : x))); }}
              onAnother={() => send("Another version, different from this one")}
              // the same words again, as if the reply had not come: it is taken out of the conversation
              onAgain={() => { const asked = turns[i - 1]; if (asked?.role === "user" && !say.isPending) say.mutate({ words: asked.content, mode: "chat", from: turns.slice(0, i - 1) }); }}
              onOption={send}
            />
          ),
        )}
        {say.isPending && <div className="self-start rounded-xl border border-line px-3 py-2 text-ink-2">Generating…</div>}
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

/** A proposed text with what changed against what was there: new words marked, words taken out struck. */
function Changed({ was, now }: { was: string; now: string }) {
  const pieces = was.trim() ? wordDiff(was, now) : null;
  // a text rewritten from end to end, or too long to compare, is read better plain
  const marked = pieces && changedShare(pieces) < 0.85 && pieces.some((p) => p.kind !== "same");
  const [plain, setPlain] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div className="rounded-lg bg-raised px-2.5 py-2 leading-normal break-words whitespace-pre-wrap">
        {marked && !plain
          ? pieces.map((p, k) => (p.kind === "same" ? <span key={k}>{p.text}</span> : p.kind === "added" ? <mark key={k} className="rounded-sm bg-accent-wash px-0.5 text-ink-strong">{p.text}</mark> : <del key={k} className="text-ink-3">{p.text}</del>))
          : now}
      </div>
      {marked && (
        <button type="button" className="self-start text-[11px] text-ink-2 underline hover:text-ink" onClick={() => setPlain(!plain)}>
          {plain ? "Show diff" : "Show plain text"}
        </button>
      )}
    </div>
  );
}

/** One thing the designer said: an answer, a question, or a proposal with what can be done with it. */
function Reply({ turn: t, last, busy, label, onUse, onUndo, onAnother, onAgain, onOption }: {
  turn: DesignerTurn;
  last: boolean;
  busy: boolean;
  label(id: string): string;
  onUse(): void;
  onUndo(): void;
  onAnother(): void;
  onAgain(): void;
  onOption(words: string): void;
}) {
  const r = t.reply;
  const [raw, setRaw] = useState(false);
  const changes = Object.entries(r?.changes ?? {});
  const short = Object.entries(r?.short ?? {});
  return (
    <div className={cx("flex flex-col gap-2 rounded-xl border p-3", r?.empty ? "border-warn/60" : "border-line")}>
      {r?.kind === "question" ? <span className="font-semibold">{r.question}</span> : null}
      {t.content && <span className={cx("whitespace-pre-wrap", r?.kind === "question" && "text-ink-2")}>{t.content}</span>}
      {r?.empty && (
        <div className="flex gap-2 rounded-lg bg-warn-wash px-2.5 py-2 text-xs text-warn-ink">
          <TriangleAlert size={14} className="mt-px shrink-0" />
          <span>
            <span className="font-semibold">It sent no text, twice.</span> Nothing was changed, whatever it says above. The LLM may be refusing what you asked: try another system prompt or another LLM (at the top of this panel), or say it another way.
          </span>
        </div>
      )}
      {changes.map(([id, value]) => (
        <div key={id} className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-ink-2">{label(id)}</span>
          <Changed was={t.was?.[id] ?? ""} now={value} />
        </div>
      ))}
      {short.length > 0 && (
        <div className="flex gap-2 rounded-lg bg-warn-wash px-2.5 py-2 text-xs text-warn-ink">
          <TriangleAlert size={14} className="mt-px shrink-0" />
          <span>
            <span className="font-semibold">Much shorter than what you have</span> ({short.map(([id, n]) => `${label(id)}: ${n.now} characters in place of ${n.was}`).join("; ")}). It may be only the line that changed: applying it replaces the whole prompt.
          </span>
        </div>
      )}
      {r?.repeats && (
        <div className="flex gap-2 rounded-lg bg-warn-wash px-2.5 py-2 text-xs text-warn-ink">
          <TriangleAlert size={14} className="mt-px shrink-0" />
          <span>
            <span className="font-semibold">This is the previous clip, written again.</span> A clip that extends it should say what happens next. Tell it what comes next in a few words ("she sits down and laughs"), or ask again.
          </span>
        </div>
      )}
      {r?.tags && (
        <span className="text-xs text-ink-2">
          {r.tags.fixed.length > 0 && <>Fixed against the danbooru tag list: {r.tags.fixed.map((f) => `${f.from} → ${f.to}`).join(", ")}. </>}
          {r.tags.unknown.length > 0 && <span className="text-warn-ink">Not danbooru tags: {r.tags.unknown.join(", ")}.</span>}
        </span>
      )}
      {(changes.length > 0 || r?.empty) && (
        <span className="flex flex-wrap items-center gap-1.5">
          {changes.length > 0 && (t.used ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-good"><Check size={13} /> Applied</span>
              {t.was && <Button size="sm" tone="quiet" title="Put back what the form held before" onClick={onUndo}><Undo2 size={13} /> Undo</Button>}
            </>
          ) : (
            <Button size="sm" tone="primary" onClick={onUse}>{short.length || r?.repeats ? "Apply anyway" : "Apply"}</Button>
          ))}
          {changes.length > 0 && last && <Button size="sm" disabled={busy} title="Ask for another version, different from this one" onClick={onAnother}><RefreshCw size={13} /> Regenerate</Button>}
          {(r?.empty || r?.repeats || short.length > 0) && last && <Button size="sm" disabled={busy} title="Ask the same thing again, as if this reply had not come" onClick={onAgain}><RotateCcw size={13} /> Retry</Button>}
          {r?.raw && <button type="button" className="text-[11px] text-ink-2 underline hover:text-ink" onClick={() => setRaw(!raw)}>{raw ? "Hide raw response" : "Raw response"}</button>}
        </span>
      )}
      {raw && r?.raw && <pre className="max-h-48 overflow-auto rounded-lg bg-raised px-2.5 py-2 font-mono text-[11px] leading-normal break-words whitespace-pre-wrap text-ink-2">{r.raw}</pre>}
      {last && r && r.options.length > 0 && (
        <span className="flex flex-wrap gap-1.5">
          {r.options.map((o) => <button key={o} type="button" disabled={busy} onClick={() => onOption(o)} className="rounded-full border border-line-strong px-2.5 py-1 text-left text-xs hover:bg-hover disabled:opacity-45">{o}</button>)}
        </span>
      )}
    </div>
  );
}

/**
 * The helpers that sit above a form's text: the designer, and snippets (bits of text kept under a
 * name: ticked, they are added to what is written each time something is made).
 */
export function WritingHelp({ recipe, text, look, onLook, onInsert, onDesigner }: {
  recipe: RecipeInfo;
  /** What the main text box holds now, to keep as a snippet. */
  text: string;
  /** The ticked snippets are part of the look, with who is in it. */
  look: Look | null;
  onLook(look: Look): void;
  onInsert(text: string): void;
  onDesigner(): void;
}) {
  const main = mainTextOf(recipe);
  if (main?.type !== "prompt") return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Button size="sm" onClick={onDesigner}><WandSparkles size={13} /> Designer</Button>
        <Snippets style={main.style} look={look} onLook={onLook} text={text} onInsert={onInsert} />
      </div>
      <TickedSnippets look={look} onLook={onLook} />
    </div>
  );
}
