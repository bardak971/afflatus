import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Search, X } from "lucide-react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { fuzzyScore, isShown, secondsInput, type InputSpec, type LoraValue, type ReferenceValue, type SizeValue, frameOf, megapixels } from "@afflatus/core";
import { api, type RecipeInfo, type RecipeStatus } from "./api";
import { useModelSettings, useRecipes } from "./data";
import { DRAG_HAS_SOUND, DRAG_PICTURE, DRAG_SOUND, DRAG_VIDEO, useDragged } from "./dragging";
import { Field, sameValue } from "./fields";
import { formDefaults } from "./form";
import { fileLabel } from "./format";
import { useSettled } from "./hooks";
import { Button, cx, ErrorNote, Segmented } from "./ui";
import { MissingModel } from "./PresetFiles";

/**
 * Which parts of a form are open. Kept for every form and every visit: a part folded once stays
 * folded, so the form shows what is being worked on and one line for the rest.
 */
const useParts = create<{ open: Record<string, boolean>; set(id: string, open: boolean): void }>()(
  persist((set) => ({ open: {}, set: (id, open) => set((s) => ({ open: { ...s.open, [id]: open } })) }), { name: "afflatus.form.parts" }),
);

/**
 * One part of a form. Folded, it is one line that says what it holds, so it need not be opened to be
 * checked; open, its fields are under that line. A part that needs something from the user (a picture
 * that is not chosen yet) is open whatever was remembered.
 */
function Part({ id, title, summary, warn, needs, head, children }: {
  id: string;
  title: string;
  /** What it holds, in a few words. */
  summary: ReactNode;
  /** A word about something in it that is heavy or wrong, shown while it is folded too. */
  warn?: string;
  needs?: boolean;
  /** A control in the header, beside the fold (a chapter's own switch). */
  head?: ReactNode;
  children: ReactNode;
}) {
  const kept = useParts((s) => s.open[id] ?? false);
  const set = useParts((s) => s.set);
  const open = kept || Boolean(needs);
  return (
    <section data-part={id} className={cx("scroll-mt-12 rounded-[10px] border", open ? "border-line-strong" : "border-line bg-raised")}>
      <div className={cx("flex items-center", Boolean(head) && "pr-3")}>
        <button type="button" aria-expanded={open} onClick={() => set(id, !open)} className="flex min-w-0 grow items-center gap-2.5 px-3 py-2 text-left">
          <span className="flex min-w-0 grow flex-col gap-0.5">
            <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">{title}</span>
            <span className={cx("truncate", open ? "text-xs text-ink-2" : "font-semibold")}>{summary}</span>
            {warn && <span className="truncate text-xs text-warn-ink">{warn}</span>}
          </span>
          <ChevronDown size={15} className={cx("shrink-0 text-ink-2 transition-transform", open && "rotate-180")} />
        </button>
        {head}
      </div>
      {open && <div className="flex flex-col gap-3.5 px-3 pt-1 pb-3">{children}</div>}
    </section>
  );
}

/** A second text of a form (the negative prompt, the sounds of a clip): a line that says what it holds, opening to the text itself. */
function TextFold({ spec, value, children }: { spec: Extract<InputSpec, { type: "prompt" }>; value: string; children: ReactNode }) {
  const id = `text:${spec.id}`;
  const open = useParts((s) => s.open[id] ?? false);
  const set = useParts((s) => s.set);
  if (open) {
    return (
      <div className="flex flex-col gap-1">
        {children}
        <button type="button" onClick={() => set(id, false)} className="self-end rounded-md px-1 text-xs text-ink-2 hover:text-ink hover:underline">Collapse</button>
      </div>
    );
  }
  return (
    <button type="button" aria-expanded={false} onClick={() => set(id, true)} className="flex h-8 items-center gap-2 rounded-lg px-1 text-left text-xs text-ink-2 hover:text-ink">
      <span className="shrink-0 font-semibold">{spec.label}</span>
      <span className="min-w-0 grow truncate">{value.trim() || "empty"}</span>
      <ChevronDown size={14} className="shrink-0" />
    </button>
  );
}

const isLoras = (v: unknown): v is LoraValue[] => Array.isArray(v);

/** The groups the settings are shown in, in order, and what each is about. */
type Group = "speed" | "upscale" | "file" | "rare";
/** Where a setting goes: what its recipe says, else what its name says. */
function groupOf(i: InputSpec): Group {
  if (i.section === "speed" || i.section === "file" || i.section === "rare") return i.section;
  if (i.section === "out") return "upscale";
  const id = i.id;
  if (/^upscale|^hires/i.test(id)) return "upscale";
  if (/fps|crf|smooth|encod|format|quality$|frame.?rate/i.test(id)) return "file";
  if (/preview|quick|^tile|loraStrength|sharpRefs|attention|offload|device|precision|cache(Threshold|Start|End|Steps)/i.test(id)) return "rare";
  return "speed";
}

/**
 * The strip at the top of a form: its parts in the order they are touched, the one in view marked;
 * a click opens a part and scrolls to it. Beside them, a search over the form's settings (typing
 * leaves only the settings that match).
 */
function Strip({ parts, open, query, setQuery, found }: {
  parts: Array<{ id: string; label: string }>;
  open(id: string): void;
  query: string;
  setQuery(q: string): void;
  /** How many settings match what is typed. */
  found: number;
}) {
  const [current, setCurrent] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const self = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searching) box.current?.focus(); }, [searching]);
  const stop = () => { setQuery(""); setSearching(false); };
  // a part clicked in the strip stays the current one until the user scrolls on their own: it may not
  // reach the top of the view (the form's end is near), and the strip must still say what was asked for
  const pinned = useRef(false);
  // the listeners are bound again when the parts change, not on every keystroke (the array is new each render)
  const partIds = parts.map((p) => p.id).join("|");
  useEffect(() => {
    // the nearest thing that scrolls: the form's parts scroll inside it
    let root = self.current?.parentElement ?? null;
    while (root && !/auto|scroll/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
    if (!root) return;
    const elements = partIds.split("|").filter(Boolean).map((id) => root.querySelector<HTMLElement>(`[data-part="${id}"]`)).filter((e): e is HTMLElement => e !== null);
    // the current part is the one under the strip when a real stretch of it is still in view (not the
    // tail of a folded line), else the one that fills most of the view
    const tell = () => {
      if (pinned.current) return;
      const box = root.getBoundingClientRect();
      const line = box.top + 56;
      let best: string | null = null;
      let most = 0;
      // scrolled to the end: the last part is the one being read, however short it is
      const last = elements[elements.length - 1];
      if (last && root.scrollTop + root.clientHeight >= root.scrollHeight - 2) {
        setCurrent(last.dataset.part ?? null);
        return;
      }
      for (const el of elements) {
        const r = el.getBoundingClientRect();
        if (r.top <= line + 1 && r.bottom > line + 120) { best = el.dataset.part ?? null; break; }
        const seen = Math.min(r.bottom, box.bottom) - Math.max(r.top, line);
        if (seen > most) { most = seen; best = el.dataset.part ?? null; }
      }
      setCurrent(best ?? elements[0]?.dataset.part ?? null);
    };
    const unpin = () => { pinned.current = false; tell(); };
    tell();
    root.addEventListener("scroll", tell, { passive: true });
    root.addEventListener("wheel", unpin, { passive: true });
    root.addEventListener("touchmove", unpin, { passive: true });
    return () => {
      root.removeEventListener("scroll", tell);
      root.removeEventListener("wheel", unpin);
      root.removeEventListener("touchmove", unpin);
    };
  }, [partIds]);
  return (
    <div ref={self} className="sticky top-0 z-10 flex shrink-0 items-center gap-x-0.5 overflow-x-hidden rounded-lg border border-line bg-raised/95 px-1 py-1 shadow-md shadow-shade/20 backdrop-blur">
      {searching ? (
        <label className="flex h-7 min-w-0 grow items-center gap-1.5 rounded-full border border-line bg-panel px-2 text-xs focus-within:border-accent">
          <Search size={13} className="shrink-0 text-ink-2" />
          <input
            ref={box}
            data-search="form"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // what is typed here is for the form alone: the screen's keys must not react to it
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); stop(); } }}
            placeholder="Find a setting (steps, cfg, shift, crf, tile…)"
            aria-label="Find a setting"
            className="min-w-0 grow bg-transparent placeholder:text-ink-3"
          />
          {query.trim() && <span className="shrink-0 text-ink-3">{found}</span>}
          <button type="button" aria-label="Stop searching" onClick={stop} className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-hover hover:text-ink"><X size={13} /></button>
        </label>
      ) : parts.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => {
            open(p.id);
            pinned.current = true;
            setCurrent(p.id);
            requestAnimationFrame(() => document.querySelector(`[data-part="${p.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
          }}
          className={cx("min-w-0 shrink rounded-full px-1.5 py-1 text-[11px] font-semibold whitespace-nowrap", current === p.id ? "bg-line-strong text-ink-strong" : "text-ink-2 hover:bg-hover hover:text-ink")}
        >
          {p.label}
        </button>
      ))}
      <span className="grow" />
      {!searching && (
        <button
          type="button"
          data-search-opener
          onClick={() => setSearching(true)}
          aria-label="Find a setting"
          title="Find a setting by its name"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-hover hover:text-ink"
        >
          <Search size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * The text a form is about: the one that must be written, else its first text. A negative prompt is
 * never that: a tool whose only text is one (an upscale) has no main text, and no help to write it.
 */
export const mainTextOf = (recipe: RecipeInfo): InputSpec | undefined =>
  recipe.inputs.find((i) => i.type === "prompt" && !i.optional) ?? recipe.inputs.find((i) => i.type === "prompt" && i.id !== "negative");
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The form of a recipe, in parts: what it is made with, what it starts from, the prompt (always open:
 * it is what changes from one try to the next), who and what is in it, what comes out, and every
 * other setting. Each part is one line until it is opened. A screen adds its own controls to a part
 * through `made`, `look` and `helpers`.
 */
export function Form({ recipe, status, stored, given, onChange, onClear, made, madeSummary, look, lookSummary, helpers }: {
  recipe: RecipeInfo;
  status: RecipeStatus | undefined;
  /** What the draft holds for this recipe: only what was touched. */
  stored: Record<string, unknown> | undefined;
  /** Inputs the screen fills in itself at render time (a timeline hands the clip before over): counted as set for what is shown, never stored. */
  given?: Record<string, unknown>;
  onChange(input: string, value: unknown): void;
  /** Let these inputs follow the defaults again. */
  onClear(inputs: string[]): void;
  /** What picks the model and the operation, first in "Made with"; and what that is, in a few words. */
  made?: ReactNode;
  madeSummary?: string;
  /** The people, places and style, first in "In it"; and who they are, in a few words. */
  look?: ReactNode;
  lookSummary?: string;
  /** What sits above the prompt: the designer, the snippets. */
  helpers?: ReactNode;
}) {
  const client = useQueryClient();
  const family = useRecipes().data?.families.find((f) => f.id === recipe.family);
  const settings = useModelSettings();
  const { defaults, file, hasSaved } = useMemo(
    () => formDefaults(recipe, status?.options, settings.data?.items ?? [], stored),
    [recipe, status, settings.data, stored],
  );
  const values = useMemo(() => ({ ...defaults, ...stored }), [defaults, stored]);
  // the two numbers that say which part of a sound is used are drawn with the sound, not as fields of their own
  const tucked = new Set(recipe.inputs.flatMap((i) => (i.type === "audio" && i.window ? [i.window.start, i.window.seconds] : [])));
  // what decides which settings show: the values, plus what the screen will fill in itself
  const seen = given ? { ...values, ...given } : values;
  const shown = recipe.inputs.filter((i) => isShown(i, seen) && !tucked.has(i.id));
  // the chapters the recipe arranges itself (an imported workflow's sections): their inputs show there and nowhere else
  const chapters = (recipe.chapters ?? []).map((ch) => ({ ...ch, items: shown.filter((i) => i.chapter === ch.id) })).filter((ch) => ch.items.length || ch.id === "advanced" || ch.id === "prompt");
  // the recipe may say where Advanced and the prompt go among its chapters; without a word, Advanced is last and the prompt first
  const advancedMoved = chapters.some((ch) => ch.id === "advanced");
  const promptMoved = chapters.some((ch) => ch.id === "prompt");
  const rest = shown.filter((i) => !i.chapter);
  // where a LoRA's trigger words go, and the one text that is always open
  const mainText = mainTextOf(recipe);
  // what is heavy for the card: asked again only when a setting changes, not while text is typed
  const settingsOnly = useMemo(() => {
    const texts = new Set(recipe.inputs.filter((i) => i.type === "prompt").map((i) => i.id));
    return Object.fromEntries(Object.entries(values).filter(([k, v]) => !texts.has(k) && v !== undefined));
  }, [recipe, values]);
  // asked once the settings have settled: a slider dragged across the form is one question, not one per pixel
  const adviceKey = useSettled(JSON.stringify(settingsOnly), 500);
  const advice = useQuery({
    queryKey: ["advice", recipe.id, adviceKey],
    queryFn: () => api.advice(recipe.id, { ...Object.fromEntries(recipe.inputs.filter((i) => i.type === "prompt" && !i.optional).map((i) => [i.id, "x"])), ...(JSON.parse(adviceKey) as Record<string, unknown>) }),
    staleTime: 60_000,
  });
  const word = (id: string) => advice.data?.items.find((a) => a.input === id);
  /** The first thing said about one of these inputs: shown on a folded part, so that it is not missed. */
  const warnOf = (inputs: InputSpec[]) => inputs.map((i) => word(i.id)?.text).find(Boolean);
  // the model in use: the one picked in the form, else the one an imported workflow loads. LoRAs made for it come first.
  const picker = recipe.inputs.find((i) => i.type === "model");
  const inUse = (picker ? String(values[picker.id] ?? "") : recipe.models?.[0]) || undefined;
  /** The form names a model file this ComfyUI does not list (a preset made elsewhere, a file removed). */
  const isMissingModel = (id: string) => typeof values[id] === "string" && values[id] !== "" && Array.isArray(status?.options[id]) && !status!.options[id]!.includes(String(values[id]));
  const render = (i: InputSpec) => {
    const a = word(i.id);
    return (
      <div key={i.id} className="flex flex-col gap-1">
        <Field
          spec={i} value={values[i.id]} values={values} options={status?.options[i.id]} family={family} model={inUse}
          onChange={(v) => onChange(i.id, v)}
          onValue={onChange}
          main={mainText?.type === "prompt" ? { text: String(values[mainText.id] ?? ""), style: mainText.style, set: (text) => onChange(mainText.id, text) } : undefined}
        />
        {a && <span className={cx("text-xs", a.level === "heavy" ? "font-semibold text-warn-ink" : "text-warn-ink")}>{a.level === "heavy" ? "Heavy: " : ""}{a.text}</span>}
        {i.type === "model" && isMissingModel(i.id) && <MissingModel folder={i.folder} file={String(values[i.id])} />}
      </div>
    );
  };

  // ---- the search: typed, only the settings whose name (or explanation) matches stay on the form
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [recipe.id]);
  const q = query.trim();
  // forgiving on the name: a word as typed, or its letters in order from the start of a word ("stps" finds
  // Steps; "tile" does not find Dis-til-led); the explanation, long, only counts when it says the words typed
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const named = (text: string) => {
    const hay = text.toLowerCase();
    return words.every((w) => hay.includes(w) || [...hay.matchAll(/(?:^|[\s_\-./()[\]:·,])(\S)/g)].some((m) => m[1] === w[0] && fuzzyScore(w, hay.slice(m.index + m[0].length - 1)) !== null));
  };
  const hit = (i: InputSpec) =>
    !q ||
    named(`${i.label} ${i.id}${i.type === "number" ? ` ${i.unit ?? ""}` : ""}`) ||
    (Boolean(i.note) && words.every((w) => i.note!.toLowerCase().includes(w)));
  const sought = <T extends InputSpec>(list: T[]): T[] => (q ? list.filter(hit) : list);
  // the settings another setting hides (the upscale factor while the upscale is off): found too, with what shows them
  const labelOf = (id: string) => recipe.inputs.find((i) => i.id === id)?.label ?? id;
  const revealedBy = (i: InputSpec): string => {
    const w = i.showWhen;
    if (!w) return "";
    if (typeof w === "string") return `shown when ${labelOf(w)} is set`;
    return `shown when ${labelOf(w.input)} is ${w.in.map((v) => (v === true ? "on" : v === false ? "off" : fileLabel(String(v)))).join(" or ")}`;
  };
  const hidden = q ? recipe.inputs.filter((i) => !isShown(i, seen) && !tucked.has(i.id) && hit(i)) : [];

  // ---- which input goes in which chapter
  // the negative prompt sits under the prompt in every form that has one, wherever its recipe filed it
  // (a form with no prompt of its own keeps it with its other settings)
  const underPrompt = (i: InputSpec) => i.type === "prompt" && i.id === "negative" && Boolean(mainText);
  const length = secondsInput(recipe.inputs);
  // a recipe can file a size or a seed under Advanced on purpose (an imported workflow leaves the shelves to its importer)
  const isOut = (i: InputSpec) => i.section !== "rare" && (i.section === "out" || i.type === "size" || i.type === "seed" || (i.type === "number" && (i.id === length?.id || i.unit?.trim() === "p")));
  const isMedia = (i: InputSpec) => i.type === "image" || i.type === "clip" || i.type === "references" || i.type === "audio";
  const front = rest.filter((i) => !i.advanced || underPrompt(i) || isMedia(i));
  const texts = sought(front.filter((i): i is Extract<InputSpec, { type: "prompt" }> => i.type === "prompt" && i.id !== mainText?.id));
  // the inputs: the frames the clip is built on, and what it is shown
  const frames = sought(rest.filter((i) => i.type === "image" || i.type === "clip"));
  const refs = sought(rest.filter((i) => i.type === "references" || i.type === "audio"));
  const loras = sought(front.filter((i) => i.type === "loras"));
  const out = sought(front.filter(isOut));
  // the model's file and the operation's own settings (how much an img2img may redraw, which upscaler)
  const knobs = sought(front.filter((i) => i.type === "model" || ((i.type === "number" || i.type === "toggle" || i.type === "choice") && !isOut(i))));
  // the settings, by what they are about
  const tuning = sought(rest.filter((i) => i.advanced && !underPrompt(i) && !isMedia(i) && !isOut(i)));
  const sampling = tuning.filter((i) => groupOf(i) === "speed");
  const upscaling = tuning.filter((i) => groupOf(i) === "upscale");
  const encoding = tuning.filter((i) => groupOf(i) === "file");
  const rare = tuning.filter((i) => groupOf(i) === "rare");

  // while something of the library is dragged, a chapter that has a place for it is open: the place is there to be dropped on
  const dragged = useDragged((s) => s.types);
  const takes = (i: InputSpec) =>
    (i.type === "image" && i.role !== "mask" && dragged.includes(DRAG_PICTURE)) ||
    (i.type === "clip" && dragged.includes(DRAG_VIDEO)) ||
    (i.type === "references" && dragged.includes(i.media === "video" ? DRAG_VIDEO : DRAG_PICTURE)) ||
    (i.type === "audio" && (dragged.includes(DRAG_SOUND) || dragged.includes(DRAG_HAS_SOUND)));

  // ---- what each chapter holds, in a few words
  const said = (i: InputSpec): string => {
    const v = values[i.id];
    if (i.type === "model") return fileLabel(String(v ?? ""));
    if (i.type === "number") return `${i.label.toLowerCase()} ${v}${i.unit ?? ""}`;
    if (i.type === "toggle") return v ? i.label.toLowerCase() : "";
    if (i.type === "choice") return fileLabel(String(v ?? ""));
    return "";
  };
  const loraCount = loras.reduce((n, i) => n + ((values[i.id] as LoraValue[] | undefined)?.length ?? 0), 0);
  const modelSaid = [madeSummary, ...knobs.map(said), loraCount ? count(loraCount, "LoRA") : ""].filter(Boolean).join(" · ");
  const framesChosen = frames.filter((i) => values[i.id]);
  const missing = frames.some((i) => !i.optional && !values[i.id]);
  const refsSaid = [
    lookSummary,
    ...refs.map((i) => {
      const v = values[i.id];
      if (i.type === "references") return Array.isArray(v) && v.length ? count((v as ReferenceValue[]).length, i.media === "video" ? "reference video" : "reference image") : "";
      return v ? i.label.toLowerCase() : "";
    }),
  ].filter(Boolean);
  const kind = recipe.output === "video" ? "vid" : recipe.output === "image" ? "img" : "audio";
  const framesSaid = framesChosen.length ? framesChosen.map((i) => i.label.toLowerCase()).join(", ") : missing ? "nothing chosen yet" : frames.length ? `txt2${kind}` : "";
  const inputsSaid = [framesSaid, ...refsSaid].filter(Boolean).join(" · ") || "none";
  const outSaid = out.map((i) => {
    const v = values[i.id];
    if (i.type === "size") {
      const s = v as SizeValue | undefined;
      const shape = i.shapes.find((x) => x.width === s?.width && x.height === s?.height);
      if (!i.ratioOnly) return `${shape ? `${shape.label} ` : ""}${s?.width} × ${s?.height}`;
      // what the short side and the proportions give: a picture or a clip in the form decides instead
      const decided = (i.decidedBy ?? []).some((id) => { const x = values[id]; return Array.isArray(x) ? x.length > 0 : Boolean(x); });
      const short = i.short ? Number(values[i.short]) : NaN;
      const frame = !decided && s && Number.isFinite(short) && short > 0 ? frameOf(s, short, { grid: i.grid, maxPixels: i.maxPixels ?? Infinity }) : null;
      const ratio = shape?.label ?? `${s?.width} : ${s?.height}`;
      const r32 = (n: number) => Math.max(64, Math.round(n / 32) * 32);
      const by = i.scaledBy && values[i.scaledBy.on] && values[i.scaledBy.on] !== "Off" ? Number(values[i.scaledBy.by] ?? 2) : 0;
      const up = frame && by ? ` → ${r32(frame.width * by)} × ${r32(frame.height * by)} · ${megapixels(r32(frame.width * by), r32(frame.height * by))}` : "";
      return frame ? `${ratio} · ${frame.width} × ${frame.height} · ${megapixels(frame.width, frame.height)}${up}` : decided ? "size of the input image" : ratio;
    }
    if (i.type === "seed") return Number(v ?? -1) === -1 ? "seed: random" : `seed ${v}`;
    // a pass that enlarges: said with the frame, not on its own
    if (out.some((o) => o.type === "size" && (o.scaledBy?.on === i.id || o.scaledBy?.by === i.id))) return "";
    if (i.type === "toggle") return v ? i.label.toLowerCase() : "";
    if (i.type === "number") {
      // the short side is already in the frame said for the shape, unless a picture decides the shape
      const sizeOf = out.find((o): o is Extract<InputSpec, { type: "size" }> => o.type === "size" && o.short === i.id);
      const decided = (sizeOf?.decidedBy ?? []).some((id) => { const x = values[id]; return Array.isArray(x) ? x.length > 0 : Boolean(x); });
      if (sizeOf && !decided) return "";
      return `${v}${i.unit ?? ""}`;
    }
    return "";
  }).filter(Boolean).join(" · ");
  const changedIn = (list: InputSpec[]) => list.filter((i) => !sameValue(values[i.id], defaults[i.id]));
  const key = (id: string) => sampling.find((i) => i.id === id);
  const samplingSaid = [
    key("steps") ? `${values.steps} steps` : key("turboSteps") && values.fast ? `${values.turboSteps} steps` : "",
    key("fast") && values.fast ? "Turbo" : "",
    key("cfg") ? `CFG ${values.cfg}` : "",
    // a sampler left to the recipe says so: "Auto" alone would say nothing
    key("sampler") ? (values.sampler === "Auto" ? "sampler: auto" : fileLabel(String(values.sampler ?? ""))) : "",
  ].filter(Boolean).join(" · ") || count(sampling.length, "setting");
  const changedMark = (list: InputSpec[]) => (changedIn(list).length ? <span className="text-accent"> · {changedIn(list).length} changed</span> : null);

  // what belongs to the model, whatever chapter of the form it is in (the size and the negative prompt are up front)
  const perModel = recipe.inputs.filter((i) => i.perModel);
  const differs = perModel.filter((i) => !sameValue(values[i.id], defaults[i.id]));
  const refetch = () => client.invalidateQueries({ queryKey: ["model-settings"] });
  const save = useMutation({
    mutationFn: () => api.saveModelSettings({ family: recipe.family, file, values: Object.fromEntries(perModel.map((i) => [i.id, values[i.id]])) }),
    onSuccess: async () => {
      await refetch();
      // they are the model's own now: the draft no longer needs to hold them
      onClear(perModel.map((i) => i.id));
    },
  });
  const forget = useMutation({ mutationFn: () => api.forgetModelSettings(recipe.family, file), onSuccess: refetch });
  const model = fileLabel(file) || "this model";

  /** A setting, with a mark and a way back when it differs from what the model starts with. */
  const setting = (i: InputSpec) => {
    const isChanged = !sameValue(values[i.id], defaults[i.id]);
    return (
      <div key={i.id} className={cx("border-l-2 pl-2.5", isChanged ? "border-accent" : "border-transparent")}>
        {render(i)}
        {isChanged && (
          <button type="button" onClick={() => onClear([i.id])} className="mt-1 rounded-md px-1 text-xs text-accent hover:underline">
            Changed · reset
          </button>
        )}
      </div>
    );
  };
  const heading = (title: string, note: string) => (
    <div className="flex items-baseline gap-2 border-b border-line pb-1">
      <span className="shrink-0 whitespace-nowrap text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">{title}</span>
      <span className="truncate text-xs text-ink-3">{note}</span>
    </div>
  );

  // the two tabs of the inputs: frames, and references; the one looked at is remembered
  const onRefs = useParts((st) => st.open["inputs:references"] ?? false);
  const setPart = useParts((st) => st.set);
  // while searching, what a screen adds (the model picker, the cast, the designer) steps aside: it is not a setting
  const hasFrames = frames.length > 0;
  const hasRefs = refs.length > 0 || (Boolean(look) && !q);
  const promptHit = Boolean(mainText) && (!q || hit(mainText as InputSpec) || texts.length > 0);
  const found = knobs.length + loras.length + texts.length + (mainText && hit(mainText) ? 1 : 0) + frames.length + refs.length + sampling.length + upscaling.length + out.length + encoding.length + rare.length + hidden.length;
  const refsCount = refsSaid.length;
  const tab = hasFrames && hasRefs ? (onRefs ? "references" : "frames") : hasFrames ? "frames" : "references";
  // something dragged in: the tab that takes it comes forward
  const refsTake = refs.some(takes);
  const framesTake = frames.some(takes);
  const shownTab = framesTake ? "frames" : refsTake ? "references" : tab;

  const parts = [
    ...((made && !q) || knobs.length || loras.length ? [{ id: "model", label: "Model" }] : []),
    ...(promptHit && !promptMoved ? [{ id: "prompt", label: "Prompt" }] : []),
    ...(hasFrames || hasRefs ? [{ id: "inputs", label: "Inputs" }] : []),
    ...chapters.filter((ch) => (ch.id === "advanced" ? rare.length > 0 : ch.id === "prompt" ? promptHit : !q || sought(ch.items).length)).map((ch) => ({ id: ch.id, label: ch.label })),
    ...(sampling.length ? [{ id: "sampling", label: "Sampling" }] : []),
    ...(out.length || encoding.length || upscaling.length ? [{ id: "output", label: "Output" }] : []),
    ...(rare.length && !advancedMoved ? [{ id: "advanced", label: "Advanced" }] : []),
  ];
  const promptBlock = mainText && promptHit && (
    <div data-part="prompt" className="flex scroll-mt-12 flex-col gap-1.5">
      {!q && helpers}
      {isShown(mainText, seen) && (!q || hit(mainText)) && render(mainText)}
      {texts.map((i) => <TextFold key={i.id} spec={i} value={String(values[i.id] ?? "")}>{render(i)}</TextFold>)}
    </div>
  );
  const advancedPart = rare.length > 0 && (
    <Part id="advanced" title="Advanced" summary={<>{count(rare.length, "setting")}{changedMark(rare)}</>} warn={warnOf(rare)} needs={Boolean(q)}>
      {rare.map(setting)}
    </Part>
  );

  return (
    <>
      <Strip parts={parts} open={(id) => id !== "prompt" && setPart(id, true)} query={query} setQuery={setQuery} found={found} />
      {q && found === 0 && <div className="px-1 text-sm text-ink-2">No setting of this form matches “{q}”.</div>}
      {((made && !q) || knobs.length > 0 || loras.length > 0) && (
        <Part id="model" title="Model" summary={modelSaid || recipe.title} warn={warnOf([...knobs, ...loras])} needs={Boolean(q)}>
          {!q && made}
          {knobs.map(render)}
          {loras.map(render)}
        </Part>
      )}
      {!promptMoved && promptBlock}
      {(hasFrames || hasRefs) && (
        <Part id="inputs" title="Inputs" summary={inputsSaid} warn={warnOf([...frames, ...refs])} needs={missing || framesTake || refsTake || Boolean(q)}>
          {hasFrames && hasRefs && !q && (
            <div className="w-full">
              <Segmented<"frames" | "references">
                label="Which inputs"
                value={shownTab}
                options={[
                  { value: "frames", label: framesChosen.length ? `Frames · ${framesChosen.length}` : "Frames" },
                  { value: "references", label: refsCount ? `References · ${refsCount}` : "References" },
                ]}
                onChange={(v) => setPart("inputs:references", v === "references")}
              />
            </div>
          )}
          {(shownTab === "frames" || q) && frames.map(render)}
          {shownTab === "references" && !q && look}
          {(shownTab === "references" || q) && refs.map(render)}
        </Part>
      )}
      {chapters.map((ch) => {
        if (ch.id === "advanced") return <div key="advanced" className="contents">{advancedPart}</div>;
        if (ch.id === "prompt") return <div key="prompt" className="contents">{promptBlock}</div>;
        const items = sought(ch.items);
        if (q && !items.length) return null;
        // what the chapter's switches say, for the folded line: "Hires fix on"
        const switches = items.filter((i) => i.type === "toggle").map((i) => `${i.label} ${values[i.id] ? "on" : "off"}`);
        return (
          <Part key={ch.id} id={ch.id} title={ch.label} needs={Boolean(q)} warn={warnOf(items)} summary={<>{switches.length ? switches.join(" · ") : count(items.length, "setting")}{changedMark(items)}</>}>
            {items.map(setting)}
          </Part>
        );
      })}
      {sampling.length > 0 && (
        <Part id="sampling" title="Sampling" summary={<>{samplingSaid}{changedMark(sampling)}</>} warn={warnOf(sampling)} needs={Boolean(q)}>
          {perModel.length > 0 && file && !q && (
            <div className="flex flex-col gap-2 text-xs text-ink-2">
              <span>
                {differs.length
                  ? `${differs.length} setting${differs.length > 1 ? "s differ" : " differs"} from ${model}'s defaults. They apply to this draft only.`
                  : hasSaved
                    ? `These are the defaults you saved for ${model}.`
                    : `No defaults saved for ${model} yet: these are the recipe's.`}
              </span>
              <span className="flex flex-wrap gap-1.5">
                {differs.length > 0 && <Button size="sm" tone="quiet" onClick={() => save.mutate()} disabled={save.isPending} title={`Save these as the defaults of ${model}`}>Save as this model's defaults</Button>}
                {differs.length > 0 && <Button size="sm" onClick={() => onClear(differs.map((i) => i.id))}>Reset all</Button>}
                {hasSaved && !differs.length && <Button size="sm" onClick={() => forget.mutate()} disabled={forget.isPending}>Forget saved defaults</Button>}
              </span>
              {(save.isError || forget.isError) && <ErrorNote>{(save.error ?? forget.error)?.message}</ErrorNote>}
            </div>
          )}
          {sampling.map(setting)}
        </Part>
      )}
      {(out.length > 0 || encoding.length > 0 || upscaling.length > 0) && (
        <Part id="output" title="Output" summary={<>{outSaid}{changedMark([...upscaling, ...encoding])}</>} warn={warnOf([...out, ...upscaling, ...encoding]) ?? (advice.data?.estimate?.pace === "over" ? "past your card's usual pace" : undefined)} needs={Boolean(q)}>
          {out.map(render)}
          {/* the tuning of the upscale pass sits with the route that turns it on */}
          {upscaling.length > 0 && heading("Upscale pass", "the second sampling over the enlarged latent: how hard it re-samples, which upscaler, tiles and stretches")}
          {upscaling.map(setting)}
          {encoding.length > 0 && heading("Encode", "frame rate, frame interpolation, compression")}
          {encoding.map(setting)}
          {/* what it will take, learned from this machine's own renders with the model: nothing assumed about the card */}
          {advice.data?.estimate && (
            <span className={cx("text-xs", advice.data.estimate.pace === "over" ? "font-semibold text-warn-ink" : "text-ink-2")} title="Learned from your own renders with this model on this machine: how long a step took at each size, and where the card stopped keeping its pace.">
              {advice.data.estimate.text}
            </span>
          )}
        </Part>
      )}
      {!advancedMoved && advancedPart}
      {hidden.length > 0 && (
        <section className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-raised px-3 py-2">
          <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">Not shown now</span>
          {hidden.map((i) => (
            <span key={i.id} className="text-xs text-ink-2"><span className="font-semibold text-ink">{i.label}</span> · {revealedBy(i)}</span>
          ))}
        </section>
      )}
    </>
  );
}
