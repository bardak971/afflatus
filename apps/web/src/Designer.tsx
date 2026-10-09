import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Send, Sparkles, WandSparkles, X } from "lucide-react";
import { api, type DesignerReply, type DesignerSession, type Look, type RecipeInfo } from "./api";
import { useSettings } from "./data";
import { Reply } from "./designer/Reply";
import { SessionBar } from "./designer/SessionBar";
import { SystemView } from "./designer/SystemView";
import { keep, recall } from "./designer/typed";
import { useLeave } from "./leave";
import { AutoText, Button, cx, ErrorNote, Help } from "./ui";

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
 * `inline`: in a column of its own place (a timeline clip's inspector), where the text it writes is; the clips around
 * are said in a line each, the prompt as it is shown until something is proposed, the earlier exchanges folded.
 */
export function Designer({ recipe, values, onApply, turns, onTurns, session, onSession, previous, story, look, mood, onClose, side = "right", draftKey }: {
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
  /** Which side of the screen it opens on, the one where it does not hide the form it writes into; or in a column of its own. */
  side?: "left" | "right" | "inline";
  /** What this conversation belongs to (a draft, a clip): what is typed and not yet sent is kept under it while the designer is closed. */
  draftKey?: string;
}) {
  const settings = useSettings();
  const client = useQueryClient();
  const [text, setText] = useState(() => recall(draftKey));
  useEffect(() => keep(draftKey, text), [draftKey, text]);
  const end = useRef<HTMLDivElement>(null);
  const boxes = recipe.inputs.filter((i) => i.type === "prompt");
  const ready = Boolean(settings.data?.llm.baseUrl && settings.data.llm.model);
  /** The system prompt shown in place of the conversation. */
  const [showingSystem, setShowingSystem] = useState(false);
  const inline = side === "inline";
  /** Inline, the LLM and the system prompt are one line until opened. */
  const [sessionOpen, setSessionOpen] = useState(false);
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
    // inside its own scrolling box only: the page around it does not move
    const box = end.current?.parentElement;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns.length, say.isPending]);
  useEffect(() => {
    // Escape in one of its own lists (the LLM, the system prompt) closes that list, not the designer
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && !(e.target as Element | null)?.closest?.("[data-floating], [role=listbox], [role=menu]") && onClose();
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
  // over the form (on the right), it comes in as a panel and fades as a still copy when closed; in the timeline (its column,
  // or on the left) it is part of the screen and does not move
  const overlayRef = useLeave("m-out", panel);
  const overlay = side === "right";
  useEffect(() => {
    // in a column of its own it stays open while the timeline is worked on: Esc or its × closes it
    if (inline) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (!el?.closest || panel.current?.contains(el)) return;
      if (el.closest('[data-designer-stays], [data-floating], [role="menu"]')) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose, inline]);
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
  // What it knows of the pictures and the clip the form holds, from how Afflatus made them: asked for
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

  const howTo = `Say what you want in your own words ("a woman has coffee on a terrace at sunset", "make the light warmer", "longer and more detailed"), or ask ("what would make this more dramatic?", "three ideas for what she says"). It writes it the way ${video ? "this video model" : "this model"} reads best. Nothing changes in your form until you press Apply.`;
  const llmName = (() => { const l = llms.find((x) => x.id === using.llm); return l ? l.name || l.model : "no LLM"; })();
  const instructionName = using.instruction ? instructions.find((i) => i.id === using.instruction)?.name ?? "system prompt" : "no system prompt";
  // inline: the clips around, what each says happens; and the prompt as it is, until something is proposed
  const near = inline && story ? [story.index - 1, story.index + 1].filter((n) => n >= 0 && n < story.clips.length).map((n) => ({ n: n + 1, says: story.clips[n] ?? "" })) : [];
  const main = boxes.find((b) => !b.optional) ?? boxes[0];
  const now = main && typeof values[main.id] === "string" ? (values[main.id] as string) : "";
  const proposing = turns.some((t) => t.reply && Object.keys(t.reply.changes).length > 0 && !t.used);
  // inline: the exchanges before the last question are folded under one line
  const cut = inline ? Math.max(0, turns.map((t) => t.role).lastIndexOf("user")) : 0;
  const turnView = (t: DesignerTurn, i: number) =>
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
    );

  return (
    <div
      ref={overlay ? overlayRef : panel}
      role={inline ? "region" : "dialog"}
      // inline, Escape is its own (it closes it): the timeline's keys leave it alone
      data-takes-escape={inline || undefined}
      aria-label="Designer"
      style={floor !== null ? { bottom: floor } : undefined}
      className={inline ? "flex min-h-0 grow flex-col" : cx("fixed bottom-10 z-30 flex w-[420px] flex-col border-line-strong bg-panel shadow-2xl shadow-shade/60", overlay && "m-panel", side === "left" ? "top-0 left-[76px] border-r" : "top-[60px] right-0 rounded-tl-xl border-t border-l")}
    >
      {inline ? (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
          <span className="text-[11px] font-bold tracking-[.08em] text-ink-3 uppercase">Designer</span>
          <Help title="Designer" text={howTo} />
          <span className="grow" />
          {ready && (
            <button type="button" aria-expanded={sessionOpen} onClick={() => setSessionOpen((v) => !v)} data-tip="The LLM and the system prompt this clip's conversation is held with" className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-2 hover:bg-hover hover:text-ink">
              <span className="min-w-0 truncate">{llmName} · {instructionName}</span>
              <ChevronDown size={12} className={cx("shrink-0 transition-transform", sessionOpen && "rotate-180")} />
            </button>
          )}
          <button type="button" aria-label="Close the designer" data-tip="Close (Esc)" onClick={onClose} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={15} /></button>
        </div>
      ) : (
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <WandSparkles size={15} className="text-accent" />
        <span className="font-semibold">Designer</span>
        <Help title="Designer" text={howTo} />
        <span className="min-w-0 truncate text-xs text-ink-2">{story && story.clips.length > 1 ? `clip ${story.index + 1} of ${story.clips.length}: it knows the whole video · ` : ""}{sees === true ? "it has looked at your image" : sees === false && values && recipe.inputs.some((i) => i.type === "image" && typeof values[i.id] === "string") ? "it works from your text only" : ""}</span>
        <span className="grow" />
        <button type="button" aria-label="Close the designer" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={15} /></button>
      </div>
      )}
      {ready && (!inline || sessionOpen) && (
        <SessionBar
          settings={settings.data}
          using={using}
          choose={choose}
          canRestart={turns.length > 0 && !say.isPending}
          onRestart={() => { onTurns([]); say.reset(); }}
          showingSystem={showingSystem}
          onShowSystem={() => setShowingSystem((v) => !v)}
        />
      )}
      {showingSystem && ready && (
        <SystemView
          body={{ recipe: recipe.id, values, previous, story, look: look ?? null, mood, llm: using.llm, instruction: using.instruction }}
          onClose={() => setShowingSystem(false)}
        />
      )}
      <div className={cx("flex min-h-0 grow flex-col gap-3 overflow-y-auto p-4", showingSystem && "hidden")}>
        {remember.isError && <ErrorNote>{remember.error.message}</ErrorNote>}
        {!ready && settings.isSuccess && (
          <ErrorNote>The designer has no LLM yet. <Link href="/settings/designer" className="font-semibold underline">Add one in Settings</Link>: any OpenAI-compatible API works, on your computer or elsewhere.</ErrorNote>
        )}
        {near.length > 0 && (
          <div className="flex flex-col gap-1 text-xs text-ink-3">
            {near.map((x) => (
              <div key={x.n} className="flex min-w-0 gap-2">
                <span className="w-12 shrink-0 font-mono">clip {x.n}</span>
                {x.says ? <span className="min-w-0 truncate" data-tip={x.says}>{x.says}</span> : <span className="italic">not written yet</span>}
              </div>
            ))}
          </div>
        )}
        {inline && main && !proposing && !say.isPending && (
          <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-raised px-3 py-2.5">
            <span className="text-[11px] font-bold tracking-[.08em] text-ink-3 uppercase">{main.label} · now</span>
            {now.trim() ? <span className="line-clamp-6 leading-normal break-words whitespace-pre-wrap">{now}</span> : <span className="text-ink-3 italic">empty</span>}
          </div>
        )}
        {/* how to talk to it is behind the ? by the title: the panel opens on room for the conversation */}
        {!turns.length && ready && !inline && <div className="text-ink-2">Say what to write or change. Nothing changes in the form until Apply.</div>}
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
        {cut > 0 && (
          <details className="group rounded-xl border border-line">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-ink-2 hover:text-ink">
              <ChevronDown size={12} className="shrink-0 -rotate-90 transition-transform group-open:rotate-0" />
              <span className="shrink-0 font-bold tracking-[.08em] uppercase">Earlier · {turns.slice(0, cut).filter((t) => t.role === "user").length}</span>
              <span className="min-w-0 truncate">{turns.slice(0, cut).filter((t) => t.role === "user").map((t) => `“${t.content}”`).join(" · ")}</span>
            </summary>
            <div className="flex flex-col gap-3 border-t border-line p-3">{turns.slice(0, cut).map((t, i) => turnView(t, i))}</div>
          </details>
        )}
        {turns.slice(cut).map((t, i) => turnView(t, i + cut))}
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
