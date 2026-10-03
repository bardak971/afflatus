import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bookmark, ChevronDown, ChevronRight, MapPin, Plus, Search, Sparkles, Trash2, User, X } from "lucide-react";
import { fuzzyFilter, type InputSpec } from "@studai/core";
import { api, thumbUrl, type Entity, type FamilyInfo, type Outfit, type PersonDef, type PlaceDef, type RecipeInfo, type StyleDef } from "../api";
import { useEntities, useRecipes, useSetup } from "../data";
import { Field, useLoraWordsOf } from "../fields";
import { fileLabel } from "../format";
import { Picker, PictureField, SoundField } from "../PictureField";
import { ModelLink } from "../ModelLink";
import { Select } from "../Select";
import { AutoText, Button, cx, Empty, ErrorNote, SectionTitle } from "../ui";

const field = "w-full rounded-lg border border-line bg-raised px-3 py-2 text-ink placeholder:text-ink-3";

/** What one model can take of a person, read from its recipes: words (tags or a sentence), a LoRA, pictures, a voice. */
function takes(family: FamilyInfo, recipes: RecipeInfo[]) {
  const mine = recipes.filter((r) => r.family === family.id);
  const has = (test: (i: InputSpec) => boolean) => mine.some((r) => r.inputs.some(test));
  return {
    tags: has((i) => i.type === "prompt" && !i.optional && i.style === "tags"),
    lora: has((i) => i.type === "loras"),
    pictures: has((i) => i.type === "references"),
    voice: has((i) => i.type === "audio" && i.role === "voice"),
  };
}

/** The pictures of a person or a place: a row to add to and take from. */
function Pictures({ value, onChange, what }: { value: string[]; onChange(value: string[]): void; what: string }) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      {value.map((id) => (
        <div key={id} className="relative">
          <img src={thumbUrl(id)} alt="" className="h-28 w-24 rounded-lg border border-line object-cover" />
          <button type="button" aria-label="Remove this image" onClick={() => onChange(value.filter((x) => x !== id))} className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-ground/85 text-ink-2 hover:text-ink"><X size={11} /></button>
        </div>
      ))}
      {value.length < 9 && (
        <button type="button" aria-label={`Add a reference image of ${what}`} onClick={() => setPicking(true)} className="flex h-28 w-24 flex-col items-center justify-center gap-1 rounded-lg border-[1.5px] border-dashed border-line-strong text-ink-2 hover:text-ink">
          <Plus size={16} />
          <span className="text-xs">Add image</span>
        </button>
      )}
      {picking && <Picker title={`A reference image of ${what}`} onClose={() => setPicking(false)} onPick={(id) => { if (!value.includes(id)) onChange([...value, id]); setPicking(false); }} />}
    </div>
  );
}

function Words({ tags, sentence, onChange, who }: { tags: string; sentence: string; onChange(patch: { tags?: string; sentence?: string }): void; who: string }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{who}, as prompt text</SectionTitle>
      <span className="text-ink-2">Some models read danbooru tags, others natural-language prompts. studai uses the one the model needs.</span>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold">Tags</span>
        <AutoText rows={1} value={tags} placeholder="brown hair, green eyes, freckles" onChange={(e) => onChange({ tags: e.target.value })} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold">Natural language</span>
        <AutoText rows={1} value={sentence} placeholder="She has brown hair, green eyes and freckles." onChange={(e) => onChange({ sentence: e.target.value })} className={field} />
      </label>
    </div>
  );
}

function PersonEditor({ def, name, onChange }: { def: PersonDef; name: string; onChange(def: PersonDef): void }) {
  const recipes = useRecipes();
  const setup = useSetup();
  const families = recipes.data?.families ?? [];
  const lorasOf = (family: string) => setup.data?.recipes.find((s) => recipes.data?.recipes.find((r) => r.id === s.id)?.family === family && s.options.loras)?.options.loras ?? [];
  const setOutfit = (id: string, patch: Partial<Outfit>) => onChange({ ...def, outfits: def.outfits.map((o) => (o.id === id ? { ...o, ...patch } : o)) });
  // the words that call the person's LoRAs up, as their files or their pages give them: offered where none is written
  const words = useLoraWordsOf(Object.values(def.models).flatMap((m) => (m.lora ? [m.lora] : [])));
  return (
    <>
      <div className="flex flex-col gap-2">
        <SectionTitle>Reference images of {name}</SectionTitle>
        <span className="text-ink-2">Used by models that take reference images. Two or three angles hold a face better than one.</span>
        <Pictures value={def.pictures} onChange={(pictures) => onChange({ ...def, pictures })} what={name} />
      </div>
      <SoundField label="Voice sample" note="A few seconds of them speaking. Models that generate audio give the person this voice." optional value={def.voice} onChange={(voice) => onChange({ ...def, voice: voice ?? null })} />
      <Words who={`How ${name} looks`} tags={def.tags} sentence={def.sentence} onChange={(p) => onChange({ ...def, ...p })} />

      <div className="flex flex-col gap-2">
        <SectionTitle>Per model</SectionTitle>
        <span className="text-ink-2">A LoRA is optional. It is a file you already have: studai does not train one.</span>
        {families.map((f) => {
          const can = takes(f, recipes.data?.recipes ?? []);
          const m = def.models[f.id] ?? { lora: null, weight: 0.8, trigger: "" };
          const set = (patch: Partial<typeof m>) => onChange({ ...def, models: { ...def.models, [f.id]: { ...m, ...patch } } });
          const uses = [
            can.pictures && def.pictures.length ? `${Math.min(3, def.pictures.length)} reference image${Math.min(3, def.pictures.length) > 1 ? "s" : ""}` : "",
            can.voice && def.voice ? "voice sample" : "",
            can.tags ? "tags" : "natural language",
            m.lora ? `LoRA ${fileLabel(m.lora)} at ${m.weight.toFixed(2)}` : "",
          ].filter(Boolean).join(" · ");
          return (
            <div key={f.id} className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-semibold">{f.name}</span>
                <span className="text-right text-xs text-ink-2">{uses}</span>
              </div>
              {can.lora ? (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                  <Select
                    size="sm"
                    label={`LoRA of ${name} for ${f.name}`}
                    value={m.lora ?? ""}
                    onChange={(file) => set({ lora: file || null })}
                    searchHint="Search your LoRAs by name"
                    options={[{ value: "", label: "No LoRA" }, ...lorasOf(f.id).map((file) => ({ value: file, label: fileLabel(file), note: file.split(/[\\/]/).slice(0, -1).join("/") }))]}
                  />
                  {m.lora && (
                    <label className="flex items-center gap-2 text-xs text-ink-2">
                      weight
                      <input type="range" min={0} max={1.5} step={0.05} value={m.weight} onChange={(e) => set({ weight: Number(e.target.value) })} className="w-24" />
                      <span className="w-8 font-mono">{m.weight.toFixed(2)}</span>
                    </label>
                  )}
                  {m.lora && <span className="col-span-2 flex min-w-0 items-baseline gap-1.5 text-xs text-ink-2">Model page: <ModelLink folder="loras" file={m.lora} className="min-w-0" /></span>}
                  {can.tags && m.lora && <input aria-label={`Trigger words for ${f.name}`} placeholder="Trigger words, if it has any" value={m.trigger} onChange={(e) => set({ trigger: e.target.value })} className={cx(field, "col-span-2 h-9 py-0")} />}
                  {can.tags && m.lora && !m.trigger.trim() && (() => {
                    const known = words.of(m.lora);
                    return known.words && known.from !== "training" ? (
                      <button type="button" onClick={() => set({ trigger: known.words.slice(0, 200) })} className="col-span-2 truncate text-left text-xs text-accent hover:underline" title={known.words}>
                        Use its trigger words: {known.words}
                      </button>
                    ) : null;
                  })()}
                </div>
              ) : (
                <span className="text-xs text-ink-3">This model takes no LoRA.</span>
              )}
              {!can.pictures && !can.lora && <span className="text-xs text-ink-3">It takes neither reference images nor a LoRA of {name}: only the prompt text is used.</span>}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>Outfits</SectionTitle>
        <span className="text-ink-2">Pick one when you add {name} to an image or a clip. Each has prompt text and, if you like, a reference image of the clothes.</span>
        {def.outfits.map((o) => (
          <div key={o.id} className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              <input aria-label="Name of the outfit" value={o.name} placeholder="Summer dress" onChange={(e) => setOutfit(o.id, { name: e.target.value })} className={cx(field, "h-9 py-0 font-semibold")} />
              <button type="button" aria-label={`Remove the outfit ${o.name}`} onClick={() => onChange({ ...def, outfits: def.outfits.filter((x) => x.id !== o.id) })} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"><Trash2 size={14} /></button>
            </div>
            <AutoText rows={1} aria-label="The outfit as tags" value={o.tags} placeholder="Tags: white summer dress" onChange={(e) => setOutfit(o.id, { tags: e.target.value })} className={field} />
            <AutoText rows={1} aria-label="The outfit in natural language" value={o.sentence} placeholder="Natural language: She wears a white summer dress." onChange={(e) => setOutfit(o.id, { sentence: e.target.value })} className={field} />
            <PictureField label="Reference image of the clothes" optional value={o.picture} onChange={(picture) => setOutfit(o.id, { picture: picture ?? null })} />
          </div>
        ))}
        <span><Button size="sm" onClick={() => onChange({ ...def, outfits: [...def.outfits, { id: crypto.randomUUID(), name: "", tags: "", sentence: "", picture: null }] })}><Plus size={13} /> New outfit</Button></span>
        <span className="text-xs text-ink-3">Without an outfit, {name} is "as in the reference images": nothing about clothes is added to the prompt.</span>
      </div>
    </>
  );
}

function PlaceEditor({ def, name, onChange }: { def: PlaceDef; name: string; onChange(def: PlaceDef): void }) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <SectionTitle>Reference images of {name}</SectionTitle>
        <span className="text-ink-2">Used by models that take reference images: the clip happens there.</span>
        <Pictures value={def.pictures} onChange={(pictures) => onChange({ ...def, pictures })} what={name} />
      </div>
      <Words who={name} tags={def.tags} sentence={def.sentence} onChange={(p) => onChange({ ...def, ...p })} />
    </>
  );
}

function StyleEditor({ def, onChange }: { def: StyleDef; onChange(def: StyleDef): void }) {
  const recipes = useRecipes();
  const setup = useSetup();
  const families = recipes.data?.families ?? [];
  const lorasOf = (family: string) => setup.data?.recipes.find((s) => recipes.data?.recipes.find((r) => r.id === s.id)?.family === family && s.options.loras)?.options.loras ?? [];
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>Per model</SectionTitle>
      <span className="text-ink-2">A style is LoRAs and prompt text. Set it up for the models you use it with; for the others it adds nothing.</span>
      {families.map((f) => {
        const can = takes(f, recipes.data?.recipes ?? []);
        const m = def.models[f.id] ?? { loras: [], words: "" };
        const set = (patch: Partial<typeof m>) => onChange({ ...def, models: { ...def.models, [f.id]: { ...m, ...patch } } });
        return (
          <div key={f.id} className="flex flex-col gap-2.5 rounded-lg border border-line p-3">
            <span className="font-semibold">{f.name}</span>
            {can.lora && <Field spec={{ id: "loras", type: "loras", label: "LoRAs", max: 4 }} value={m.loras} options={lorasOf(f.id)} family={f} onChange={(loras) => set({ loras: loras as StyleDef["models"][string]["loras"] })} />}
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold">Prompt text {can.tags ? "(tags)" : "(natural language)"}</span>
              <AutoText rows={1} value={m.words} placeholder={can.tags ? "film grain, warm light" : "Shot on film, in warm evening light."} onChange={(e) => set({ words: e.target.value })} className={field} />
            </label>
          </div>
        );
      })}
    </div>
  );
}

type Tab = "person" | "place" | "style" | "snippet" | "preset";
type Snippet = Extract<Entity, { kind: "snippet" }>;
const TABS: Array<{ id: Tab; title: string; add: string; icon: ReactNode }> = [
  { id: "person", title: "People", add: "New person", icon: <User size={22} /> },
  { id: "place", title: "Places", add: "New place", icon: <MapPin size={22} /> },
  { id: "style", title: "Styles", add: "New style", icon: <Sparkles size={22} /> },
  { id: "snippet", title: "Snippets", add: "New snippet", icon: <Bookmark size={22} /> },
  { id: "preset", title: "Presets", add: "", icon: <Bookmark size={22} /> },
];
const TAB_KEY = "studai.kit.tab";
const OPEN_KEY = "studai.kit.categories";
const remembered = <T,>(key: string, otherwise: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : otherwise;
  } catch {
    return otherwise;
  }
};
const remember = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // nowhere to remember it: it holds for this visit
  }
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** One line about an item, under its name. */
function summaryOf(e: Entity, recipes: RecipeInfo[]): string {
  if (e.kind === "person") return `${plural(e.def.pictures.length, "reference image")}, ${e.def.voice ? "voice sample" : "no voice sample"}, ${plural(e.def.outfits.length, "outfit")}`;
  if (e.kind === "place") return plural(e.def.pictures.length, "reference image");
  if (e.kind === "style") return `set up for ${plural(Object.values(e.def.models).filter((m) => m.loras.length || m.words.trim()).length, "model")}`;
  if (e.kind === "preset") return `${recipes.find((r) => r.id === e.def.recipe)?.title ?? "a model that is no longer here"} · ${plural(Object.keys(e.def.inputs).length, "parameter")} kept`;
  return e.def.text;
}
/** Everything an item is found by. */
function textOf(e: Entity): string {
  if (e.kind === "person") return `${e.name} ${e.def.tags} ${e.def.sentence} ${e.def.outfits.map((o) => o.name).join(" ")}`;
  if (e.kind === "place") return `${e.name} ${e.def.tags} ${e.def.sentence}`;
  if (e.kind === "style") return `${e.name} ${Object.values(e.def.models).map((m) => m.words).join(" ")}`;
  if (e.kind === "snippet") return `${e.name} ${e.def.category} ${e.def.text}`;
  return e.name;
}

/** A button that asks once more before it deletes: the second click, within a few seconds, does it. */
function DeleteButton({ label, onDelete, className }: { label: string; onDelete(): void; className?: string }) {
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const back = setTimeout(() => setSure(false), 4000);
    return () => clearTimeout(back);
  }, [sure]);
  return sure ? (
    <button type="button" onClick={onDelete} className={cx("flex h-8 shrink-0 items-center rounded-md bg-warn px-2 text-xs font-semibold text-warn-on", className)}>Delete?</button>
  ) : (
    <button type="button" aria-label={label} title={label} onClick={() => setSure(true)} className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink", className)}><Trash2 size={14} /></button>
  );
}

const cell = "w-full rounded-md border border-transparent bg-transparent px-2 text-ink placeholder:text-ink-3 hover:border-line focus:border-accent focus:bg-raised";
const STYLE_WORDS = { any: "Any prompt", tags: "Tags", sentences: "Natural language" } as const;

/**
 * One snippet as a row that is changed where it stands. Its name and its category are kept when the
 * field is left (a row does not jump to another place while it is typed in); its text also a moment
 * after the typing stops.
 */
function SnippetRow({ snippet, ticked, onTick, fresh }: { snippet: Snippet; ticked: boolean; onTick(on: boolean): void; fresh: boolean }) {
  const client = useQueryClient();
  const [name, setName] = useState(snippet.name);
  const [category, setCategory] = useState(snippet.def.category);
  const [text, setText] = useState(snippet.def.text);
  // moved to another category from the bar above, or renamed elsewhere: the row follows
  useEffect(() => setCategory(snippet.def.category), [snippet.def.category]);
  useEffect(() => setName(snippet.name), [snippet.name]);
  const save = useMutation({
    mutationFn: (next: { name: string; def: Snippet["def"] }) => api.saveEntity(snippet.id, next),
    onSuccess: () => client.invalidateQueries({ queryKey: ["entities"] }),
  });
  const remove = useMutation({ mutationFn: () => api.deleteEntity(snippet.id), onSuccess: () => client.invalidateQueries({ queryKey: ["entities"] }) });
  const commit = (over: { name?: string; category?: string; text?: string; style?: Snippet["def"]["style"] } = {}) => {
    const next = {
      name: (over.name ?? name).trim() || "Unnamed",
      def: { text: over.text ?? text, category: (over.category ?? category).trim(), style: over.style !== undefined ? over.style : snippet.def.style },
    };
    if (next.name === snippet.name && next.def.text === snippet.def.text && next.def.category === snippet.def.category && next.def.style === snippet.def.style) return;
    save.mutate(next);
  };
  // the latest of it, for the save that waits for the typing to stop
  const latest = useRef(commit);
  latest.current = commit;
  const wait = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (wait.current) clearTimeout(wait.current);
  }, []);
  const leaveOnEnter = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && e.currentTarget.blur();
  return (
    <div className={cx("grid grid-cols-[auto_minmax(110px,190px)_minmax(90px,150px)_minmax(0,1fr)_112px_auto] items-start gap-1.5 rounded-lg px-1.5 py-0.5", ticked ? "bg-accent-wash" : "hover:bg-panel")}>
      <label className="flex h-8 w-7 items-center justify-center">
        <input type="checkbox" aria-label={`Tick ${snippet.name}`} checked={ticked} onChange={(e) => onTick(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
      </label>
      <input
        aria-label="Name of the snippet" value={name} maxLength={120} autoFocus={fresh}
        onFocus={(e) => fresh && e.currentTarget.select()}
        onChange={(e) => setName(e.target.value)} onBlur={() => commit()} onKeyDown={leaveOnEnter}
        className={cx(cell, "h-8 font-semibold")}
      />
      <input
        aria-label={`Category of ${snippet.name}`} value={category} maxLength={40} placeholder="No category"
        onChange={(e) => setCategory(e.target.value)} onBlur={() => commit()} onKeyDown={leaveOnEnter}
        className={cx(cell, "h-8 text-ink-2")}
      />
      <AutoText
        aria-label={`Text of ${snippet.name}`} rows={1} value={text} placeholder="Its text. {a|b|c} is a wildcard: one is picked each time"
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          if (wait.current) clearTimeout(wait.current);
          wait.current = setTimeout(() => latest.current({ text: value }), 800);
        }}
        onBlur={() => {
          if (wait.current) clearTimeout(wait.current);
          commit();
        }}
        className={cx(cell, "py-1.5 leading-normal")}
      />
      <Select
        size="sm" className="h-8" label={`The prompt style ${snippet.name} is written for`}
        value={snippet.def.style ?? "any"}
        onChange={(v) => commit({ style: v === "any" ? null : (v as "tags" | "sentences") })}
        options={(["any", "tags", "sentences"] as const).map((v) => ({ value: v, label: STYLE_WORDS[v] }))}
      />
      <DeleteButton label={`Delete the snippet ${snippet.name}`} onDelete={() => remove.mutate()} />
      {(save.isError || remove.isError) && <div className="col-span-6"><ErrorNote>{(save.error ?? remove.error)?.message}</ErrorNote></div>}
    </div>
  );
}

/**
 * Every snippet as a list that is changed in place: by category (each folds away), narrowed to one
 * category or by the search, several ticked at once to move them to another category or delete them.
 */
function SnippetTable({ snippets, query }: { snippets: Snippet[]; query: string }) {
  const client = useQueryClient();
  const [only, setOnly] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [folds, setFolds] = useState<Record<string, boolean>>(() => remembered(OPEN_KEY, {}));
  const [fresh, setFresh] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState("");
  const categories = [...new Set(snippets.map((s) => s.def.category))].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b));
  const narrowed = only === null ? snippets : snippets.filter((s) => s.def.category === only);
  const found = query.trim() ? fuzzyFilter(narrowed, query, textOf) : narrowed;
  // a category that is gone (its last snippet moved away) is no filter any more
  useEffect(() => {
    if (only !== null && !snippets.some((s) => s.def.category === only)) setOnly(null);
  }, [only, snippets]);
  const refresh = () => client.invalidateQueries({ queryKey: ["entities"] });
  const create = useMutation({
    mutationFn: () => api.createEntity("snippet", "New snippet", { text: "", category: only ?? "", style: null }),
    onSuccess: async (made) => {
      await refresh();
      setFresh(made.id);
    },
  });
  const chosen = snippets.filter((s) => ticked.has(s.id));
  const move = useMutation({
    mutationFn: (category: string) => Promise.all(chosen.map((s) => api.saveEntity(s.id, { def: { ...s.def, category } }))),
    onSuccess: () => {
      setTicked(new Set());
      return refresh();
    },
  });
  const removeAll = useMutation({
    mutationFn: () => Promise.all(chosen.map((s) => api.deleteEntity(s.id))),
    onSuccess: () => {
      setTicked(new Set());
      return refresh();
    },
  });
  // a long list starts folded; a search, one category or a short list shows everything
  const narrow = Boolean(query.trim()) || only !== null || snippets.length <= 40;
  const isOpen = (c: string) => narrow || (folds[c] ?? false) || found.some((s) => s.id === fresh && s.def.category === c);
  const fold = (c: string, open: boolean) => {
    const next = { ...folds, [c]: open };
    setFolds(next);
    remember(OPEN_KEY, next);
  };
  const tick = (ids: string[], on: boolean) => setTicked((old) => {
    const next = new Set(old);
    for (const id of ids) (on ? next.add(id) : next.delete(id));
    return next;
  });
  const chip = (label: string, count: number, value: string | null) => (
    <button key={label} type="button" aria-pressed={only === value} onClick={() => setOnly(value)} className={cx("flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs", only === value ? "border-ink bg-ink font-semibold text-ground" : "border-line text-ink-2 hover:text-ink")}>
      {label} <span className={only === value ? "" : "text-ink-3"}>{count}</span>
    </button>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {chip("All", snippets.length, null)}
        {categories.map((c) => chip(c || "No category", snippets.filter((s) => s.def.category === c).length, c))}
        <span className="grow" />
        <Button size="sm" tone="primary" disabled={create.isPending} onClick={() => create.mutate()}><Plus size={13} /> New snippet{only ? ` in ${only}` : ""}</Button>
      </div>
      {chosen.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-accent bg-panel px-3 py-2">
          <span className="font-semibold">{chosen.length} ticked</span>
          <div className="w-52">
            <Select
              size="sm" label="Move the ticked snippets to a category" placeholder="Move to a category" value=""
              onChange={(c) => move.mutate(c === "__none__" ? "" : c)}
              options={[...categories.filter(Boolean).map((c) => ({ value: c, label: c })), { value: "__none__", label: "No category" }]}
              footer={(close) => (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newCategory.trim()) return;
                    move.mutate(newCategory.trim());
                    setNewCategory("");
                    close();
                  }}
                >
                  <input aria-label="A new category" placeholder="A new category" maxLength={40} value={newCategory} onChange={(e) => setNewCategory(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="h-8 min-w-0 grow rounded-md bg-raised px-2 placeholder:text-ink-3" />
                  <Button size="sm" tone="quiet" type="submit" disabled={!newCategory.trim()}>Move</Button>
                </form>
              )}
            />
          </div>
          <DeleteButton label={`Delete the ${chosen.length} ticked snippets`} onDelete={() => removeAll.mutate()} />
          <span className="grow" />
          <Button size="sm" tone="quiet" onClick={() => setTicked(new Set())}>Untick all</Button>
        </div>
      )}
      {(create.isError || move.isError || removeAll.isError) && <ErrorNote>{(create.error ?? move.error ?? removeAll.error)?.message}</ErrorNote>}
      {snippets.length === 0 && (
        <Empty title="No snippets yet">A snippet is a bit of prompt text kept under a name: a pose, a light, a camera move. Under "Snippets" above a form, tick it and it is appended to your prompt each time you generate; the dice ticks one of each category at random.</Empty>
      )}
      {snippets.length > 0 && found.length === 0 && <Empty title="Nothing matches">No snippet has these words in its name, its category or its text.</Empty>}
      {found.length > 0 && (
        <div className="grid grid-cols-[auto_minmax(110px,190px)_minmax(90px,150px)_minmax(0,1fr)_112px_auto] gap-1.5 px-1.5 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">
          <span className="w-7" /><span className="px-2">Name</span><span className="px-2">Category</span><span className="px-2">Text</span><span>Prompt style</span><span className="w-8" />
        </div>
      )}
      {categories.filter((c) => found.some((s) => s.def.category === c)).map((c) => {
        const rows = found.filter((s) => s.def.category === c);
        const open = isOpen(c);
        const all = rows.every((s) => ticked.has(s.id));
        return (
          <section key={c || "none"} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 border-b border-line pb-1">
              <label className="flex h-7 w-7 items-center justify-center pl-1.5" title={`Tick every snippet of ${c || "no category"}`}>
                <input type="checkbox" aria-label={`Tick every snippet of ${c || "no category"}`} checked={all} onChange={(e) => tick(rows.map((s) => s.id), e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
              </label>
              <button type="button" aria-expanded={open} disabled={narrow} onClick={() => fold(c, !open)} className="flex grow items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs font-bold tracking-[0.06em] text-ink-2 uppercase enabled:hover:text-ink">
                {!narrow && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
                {c || "No category"}
                <span className="font-normal text-ink-3">{rows.length}</span>
              </button>
            </div>
            {open && rows.map((s) => <SnippetRow key={s.id} snippet={s} ticked={ticked.has(s.id)} onTick={(on) => tick([s.id], on)} fresh={fresh === s.id} />)}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The prompt kit: everything written once and added to prompts afterwards. The kinds are tabs across
 * the top (people, places, styles, snippets, presets), with a search; under them, what there is of
 * the chosen kind. People and places are cards with their picture, styles and presets a list: each
 * opens over the whole page to be changed. Snippets are changed in the list itself.
 */
export function People() {
  const entities = useEntities();
  const client = useQueryClient();
  const recipes = useRecipes();
  const all = entities.data?.items ?? [];
  // the tab named in the address ("/kit#snippets") when there is one, else the one last looked at
  const [tab, setTabNow] = useState<Tab>(() => TABS.find((t) => `#${t.title.toLowerCase()}` === window.location.hash)?.id ?? remembered<Tab>(TAB_KEY, "person"));
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const stored = all.find((e) => e.id === open) ?? null;

  // what is on screen is saved half a second after the last change
  const [edit, setEdit] = useState<Entity | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Entity | null>(null);
  const [saved, setSaved] = useState<"saved" | "saving" | "failed">("saved");
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const e = pending.current;
    if (!e) return;
    pending.current = null;
    try {
      await api.saveEntity(e.id, { name: e.name.trim() || "Unnamed", def: e.def });
      await client.invalidateQueries({ queryKey: ["entities"] });
      if (!pending.current) setSaved("saved");
    } catch {
      setSaved("failed");
    }
  }, [client]);
  useEffect(() => () => void flush(), [flush]);
  useEffect(() => {
    if (stored && stored.id !== edit?.id) setEdit(stored);
    if (!stored && !entities.isLoading) setEdit(null);
  }, [stored, edit?.id, entities.isLoading]);
  const change = (next: Entity) => {
    setEdit(next);
    pending.current = next;
    setSaved("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 500);
  };
  /** Back to the list, with what was changed kept. */
  const close = () => void flush().then(() => {
    setOpen(null);
    setRemoving(false);
  });
  const setTab = (next: Tab) => {
    remember(TAB_KEY, next);
    setQuery("");
    void flush().then(() => {
      setOpen(null);
      setRemoving(false);
      setTabNow(next);
    });
  };

  const create = useMutation({
    mutationFn: (kind: "person" | "place" | "style") => api.createEntity(kind, kind === "person" ? "New person" : kind === "place" ? "New place" : "New style"),
    onSuccess: async (e) => {
      await client.invalidateQueries({ queryKey: ["entities"] });
      setOpen(e.id);
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteEntity,
    onSuccess: () => {
      pending.current = null;
      setOpen(null);
      setRemoving(false);
      return client.invalidateQueries({ queryKey: ["entities"] });
    },
  });

  const here = TABS.find((t) => t.id === tab)!;
  const mine = all.filter((e) => e.kind === tab);
  const found = query.trim() ? fuzzyFilter(mine, query, textOf) : mine;
  const editing = edit && open === edit.id && edit.kind !== "snippet" ? edit : null;
  const newTile = (className: string) =>
    tab !== "snippet" && tab !== "preset" && (
      <button type="button" disabled={create.isPending} onClick={() => create.mutate(tab)} className={cx("flex items-center justify-center gap-2 rounded-[10px] border-[1.5px] border-dashed border-line-strong text-ink-2 hover:border-accent hover:text-ink", className)}>
        <Plus size={16} /> {here.add}
      </button>
    );

  return (
    <div className="flex min-h-0 min-w-0 grow flex-col">
      <header className="grid h-[60px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 px-6">
        <h1 className="text-base font-semibold">Prompt kit</h1>
        <div role="tablist" aria-label="What to show" className="flex gap-1 rounded-[10px] bg-raised p-[3px]">
          {TABS.map((t) => {
            const on = t.id === tab;
            return (
              <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => setTab(t.id)} className={cx("flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-xs font-semibold whitespace-nowrap", on ? "bg-line-strong text-ink-strong" : "text-ink-2 hover:text-ink")}>
                {t.title} <span className={cx("font-normal", on ? "text-ink-2" : "text-ink-3")}>{all.filter((e) => e.kind === t.id).length}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-end">
          {!editing && (
            <label className="flex h-9 w-64 min-w-0 items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent">
              <Search size={14} className="shrink-0 text-ink-3" />
              <input data-search aria-label={`Search your ${here.title.toLowerCase()}`} placeholder={`Search your ${here.title.toLowerCase()}`} value={query} onChange={(e) => setQuery(e.target.value)} className="min-w-0 grow bg-transparent placeholder:text-ink-3 focus:outline-none" />
              {query && <button type="button" aria-label="Clear the search" onClick={() => setQuery("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
            </label>
          )}
        </div>
      </header>

      <main className="min-h-0 grow overflow-y-auto px-6 pb-8">
        {(entities.isError || create.isError || remove.isError) && <div className="pb-3"><ErrorNote>{(entities.error ?? create.error ?? remove.error)?.message}</ErrorNote></div>}
        {editing ? (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={close}><ArrowLeft size={14} /> {here.title}</Button>
              <input aria-label="Name" value={editing.name} onChange={(e) => change({ ...editing, name: e.target.value })} className="h-11 min-w-0 grow rounded-lg border border-transparent bg-transparent px-2 text-xl font-semibold hover:border-line focus:border-accent focus:bg-raised" />
              <span className={cx("shrink-0 rounded-full px-2.5 py-0.5 text-[11px]", saved === "failed" ? "bg-warn-wash text-warn-ink" : "bg-raised text-ink-2")}>{saved === "saved" ? "Saved" : saved === "saving" ? "Saving…" : "Could not save"}</span>
              {removing ? (
                <>
                  <span className="text-xs text-ink-2">{editing.kind === "person" || editing.kind === "place" ? "Its reference images stay in your library." : "It cannot be brought back."}</span>
                  <Button size="sm" tone="danger" onClick={() => remove.mutate(editing.id)}>Delete</Button>
                  <Button size="sm" tone="quiet" onClick={() => setRemoving(false)}>Cancel</Button>
                </>
              ) : (
                <button type="button" aria-label={`Delete ${editing.name}`} onClick={() => setRemoving(true)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><Trash2 size={15} /></button>
              )}
            </div>
            {editing.kind === "person" && <PersonEditor def={editing.def} name={editing.name || "this person"} onChange={(def) => change({ ...editing, def })} />}
            {editing.kind === "place" && <PlaceEditor def={editing.def} name={editing.name || "this place"} onChange={(def) => change({ ...editing, def })} />}
            {editing.kind === "style" && <StyleEditor def={editing.def} onChange={(def) => change({ ...editing, def })} />}
            {editing.kind === "preset" && (
              <div className="flex flex-col gap-2 text-ink-2">
                <span>Generation parameters kept under a name: the model, its form, and the references. Use it from the form in Studio, under "Model".</span>
                <span>Model: <span className="text-ink">{recipes.data?.recipes.find((r) => r.id === editing.def.recipe)?.title ?? "a model that is no longer here"}</span></span>
                <span>Parameters kept: <span className="text-ink">{Object.keys(editing.def.inputs).length}</span></span>
              </div>
            )}
          </div>
        ) : tab === "snippet" ? (
          <SnippetTable snippets={all.filter((e): e is Snippet => e.kind === "snippet")} query={query} />
        ) : (
          <>
            {mine.length === 0 && tab === "preset" && <Empty title="No presets yet">A preset is generation parameters kept under a name: the model, its form, and the references. Save one from the form in Studio, under "Model".</Empty>}
            {mine.length > 0 && found.length === 0 && <Empty title="Nothing matches">None of your {here.title.toLowerCase()} has these words.</Empty>}
            {(tab === "person" || tab === "place") && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3.5">
                {found.map((e) => {
                  const face = e.kind === "person" || e.kind === "place" ? e.def.pictures[0] : undefined;
                  return (
                    <button key={e.id} type="button" onClick={() => setOpen(e.id)} className="flex flex-col overflow-hidden rounded-[10px] border border-line bg-panel text-left hover:border-accent">
                      <span className="flex aspect-[4/5] items-center justify-center overflow-hidden bg-raised text-ink-3">
                        {face ? <img src={thumbUrl(face)} alt="" loading="lazy" className="h-full w-full object-cover" /> : here.icon}
                      </span>
                      <span className="flex min-w-0 flex-col px-3 py-2">
                        <span className="truncate font-semibold">{e.name}</span>
                        <span className="truncate text-xs text-ink-2">{summaryOf(e, recipes.data?.recipes ?? [])}</span>
                      </span>
                    </button>
                  );
                })}
                {!query.trim() && newTile("aspect-[4/5] flex-col")}
              </div>
            )}
            {(tab === "style" || tab === "preset") && (
              <div className="mx-auto flex max-w-3xl flex-col gap-2">
                {found.map((e) => (
                  <button key={e.id} type="button" onClick={() => setOpen(e.id)} className="flex h-14 items-center gap-3 rounded-[10px] border border-line bg-panel px-4 text-left hover:border-accent">
                    <span className="shrink-0 text-ink-3">{tab === "style" ? <Sparkles size={16} /> : <Bookmark size={16} />}</span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-semibold">{e.name}</span>
                      <span className="truncate text-xs text-ink-2">{summaryOf(e, recipes.data?.recipes ?? [])}</span>
                    </span>
                  </button>
                ))}
                {!query.trim() && newTile("h-12")}
              </div>
            )}
            {mine.length === 0 && tab !== "preset" && (
              <div className="pt-4 text-center text-ink-2">
                {tab === "person" ? "A person is reference images, a voice sample and prompt text. studai gives each model what it can take: tags or natural language, a LoRA, reference images, the voice sample."
                  : tab === "place" ? "A place is reference images and prompt text: the clip or the image happens there."
                  : "A style is LoRAs and prompt text, set up for the models you use it with."}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
