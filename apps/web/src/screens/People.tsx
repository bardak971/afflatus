import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bookmark, MapPin, Plus, Sparkles, Trash2, User, X } from "lucide-react";
import type { InputSpec } from "@studai/core";
import { api, thumbUrl, type Entity, type FamilyInfo, type Outfit, type PersonDef, type PlaceDef, type RecipeInfo, type StyleDef } from "../api";
import { useEntities, useRecipes, useSetup } from "../data";
import { Field } from "../fields";
import { fileLabel } from "../format";
import { Picker, PictureField, SoundField } from "../PictureField";
import { Select } from "../Select";
import { AutoText, Button, cx, Empty, ErrorNote, SectionTitle } from "../ui";

const field = "w-full rounded-lg border border-line bg-raised px-3 py-2 text-ink placeholder:text-ink-3";
const KINDS = [
  { kind: "person" as const, title: "People", add: "New person", icon: <User size={14} /> },
  { kind: "place" as const, title: "Places", add: "New place", icon: <MapPin size={14} /> },
  { kind: "style" as const, title: "Styles", add: "New style", icon: <Sparkles size={14} /> },
];

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
          <button type="button" aria-label="Take this picture out" onClick={() => onChange(value.filter((x) => x !== id))} className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-ground/85 text-ink-2 hover:text-ink"><X size={11} /></button>
        </div>
      ))}
      {value.length < 9 && (
        <button type="button" aria-label={`Add a picture of ${what}`} onClick={() => setPicking(true)} className="flex h-28 w-24 flex-col items-center justify-center gap-1 rounded-lg border-[1.5px] border-dashed border-line-strong text-ink-2 hover:text-ink">
          <Plus size={16} />
          <span className="text-xs">Add a picture</span>
        </button>
      )}
      {picking && <Picker title={`A picture of ${what}`} onClose={() => setPicking(false)} onPick={(id) => { if (!value.includes(id)) onChange([...value, id]); setPicking(false); }} />}
    </div>
  );
}

function Words({ tags, sentence, onChange, who }: { tags: string; sentence: string; onChange(patch: { tags?: string; sentence?: string }): void; who: string }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{who}, in words</SectionTitle>
      <span className="text-ink-2">Some models read tags, others read sentences. studai uses the one the model needs.</span>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold">As tags</span>
        <AutoText rows={1} value={tags} placeholder="brown hair, green eyes, freckles" onChange={(e) => onChange({ tags: e.target.value })} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold">As a sentence</span>
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
  return (
    <>
      <div className="flex flex-col gap-2">
        <SectionTitle>Pictures of {name}</SectionTitle>
        <span className="text-ink-2">Used by models that take reference pictures. Two or three angles hold a face better than one.</span>
        <Pictures value={def.pictures} onChange={(pictures) => onChange({ ...def, pictures })} what={name} />
      </div>
      <SoundField label="Voice" note="A few seconds of them speaking. Models that make sound give the person this voice." optional value={def.voice} onChange={(voice) => onChange({ ...def, voice: voice ?? null })} />
      <Words who={`How ${name} looks`} tags={def.tags} sentence={def.sentence} onChange={(p) => onChange({ ...def, ...p })} />

      <div className="flex flex-col gap-2">
        <SectionTitle>What each model uses</SectionTitle>
        <span className="text-ink-2">A LoRA is optional. It is a file you already have: studai does not train one.</span>
        {families.map((f) => {
          const can = takes(f, recipes.data?.recipes ?? []);
          const m = def.models[f.id] ?? { lora: null, weight: 0.8, trigger: "" };
          const set = (patch: Partial<typeof m>) => onChange({ ...def, models: { ...def.models, [f.id]: { ...m, ...patch } } });
          const uses = [
            can.pictures && def.pictures.length ? `${Math.min(3, def.pictures.length)} of the pictures` : "",
            can.voice && def.voice ? "the voice" : "",
            can.tags ? "the tags" : "the sentence",
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
                      strength
                      <input type="range" min={0} max={1.5} step={0.05} value={m.weight} onChange={(e) => set({ weight: Number(e.target.value) })} className="w-24" />
                      <span className="w-8 font-mono">{m.weight.toFixed(2)}</span>
                    </label>
                  )}
                  {can.tags && m.lora && <input aria-label={`Trigger word for ${f.name}`} placeholder="Its trigger word, if it has one" value={m.trigger} onChange={(e) => set({ trigger: e.target.value })} className={cx(field, "col-span-2 h-9 py-0")} />}
                </div>
              ) : (
                <span className="text-xs text-ink-3">This model takes no LoRA.</span>
              )}
              {!can.pictures && !can.lora && <span className="text-xs text-ink-3">It has no way to take a picture or a LoRA of {name}: only the words are used.</span>}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>Outfits</SectionTitle>
        <span className="text-ink-2">Pick one when you add {name} to a picture or a clip. Each has words and, if you like, a picture of the clothes.</span>
        {def.outfits.map((o) => (
          <div key={o.id} className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              <input aria-label="Name of the outfit" value={o.name} placeholder="Summer dress" onChange={(e) => setOutfit(o.id, { name: e.target.value })} className={cx(field, "h-9 py-0 font-semibold")} />
              <button type="button" aria-label={`Remove the outfit ${o.name}`} onClick={() => onChange({ ...def, outfits: def.outfits.filter((x) => x.id !== o.id) })} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"><Trash2 size={14} /></button>
            </div>
            <AutoText rows={1} aria-label="The outfit as tags" value={o.tags} placeholder="As tags: white summer dress" onChange={(e) => setOutfit(o.id, { tags: e.target.value })} className={field} />
            <AutoText rows={1} aria-label="The outfit as a sentence" value={o.sentence} placeholder="As a sentence: She wears a white summer dress." onChange={(e) => setOutfit(o.id, { sentence: e.target.value })} className={field} />
            <PictureField label="A picture of the clothes" optional value={o.picture} onChange={(picture) => setOutfit(o.id, { picture: picture ?? null })} />
          </div>
        ))}
        <span><Button size="sm" onClick={() => onChange({ ...def, outfits: [...def.outfits, { id: crypto.randomUUID(), name: "", tags: "", sentence: "", picture: null }] })}><Plus size={13} /> New outfit</Button></span>
        <span className="text-xs text-ink-3">Without an outfit, {name} is "as in the pictures": no words about clothes are added.</span>
      </div>
    </>
  );
}

function PlaceEditor({ def, name, onChange }: { def: PlaceDef; name: string; onChange(def: PlaceDef): void }) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <SectionTitle>Pictures of {name}</SectionTitle>
        <span className="text-ink-2">Used by models that take reference pictures: the clip happens there.</span>
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
      <SectionTitle>What it is, for each model</SectionTitle>
      <span className="text-ink-2">A style is LoRAs and words. Set it up for the models you use it with; for the others it adds nothing.</span>
      {families.map((f) => {
        const can = takes(f, recipes.data?.recipes ?? []);
        const m = def.models[f.id] ?? { loras: [], words: "" };
        const set = (patch: Partial<typeof m>) => onChange({ ...def, models: { ...def.models, [f.id]: { ...m, ...patch } } });
        return (
          <div key={f.id} className="flex flex-col gap-2.5 rounded-lg border border-line p-3">
            <span className="font-semibold">{f.name}</span>
            {can.lora && <Field spec={{ id: "loras", type: "loras", label: "LoRAs", max: 4 }} value={m.loras} options={lorasOf(f.id)} family={f} onChange={(loras) => set({ loras: loras as StyleDef["models"][string]["loras"] })} />}
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold">Words {can.tags ? "(tags)" : "(a sentence)"}</span>
              <AutoText rows={1} value={m.words} placeholder={can.tags ? "film grain, warm light" : "Shot on film, in warm evening light."} onChange={(e) => set({ words: e.target.value })} className={field} />
            </label>
          </div>
        );
      })}
    </div>
  );
}

/** People, places and styles: written once, used with every model. */
export function People() {
  const entities = useEntities();
  const client = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const all = entities.data?.items ?? [];
  const presets = all.filter((e) => e.kind === "preset" || e.kind === "snippet");
  const recipes = useRecipes();
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
      void client.invalidateQueries({ queryKey: ["entities"] });
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

  const create = useMutation({
    mutationFn: (kind: "person" | "place" | "style") => api.createEntity(kind, kind === "person" ? "New person" : kind === "place" ? "New place" : "New style"),
    onSuccess: async (e) => {
      await flush();
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

  return (
    <div className="flex min-h-0 grow">
      <aside className="flex w-[260px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-panel p-3">
        {KINDS.map((k) => (
          <div key={k.kind} className="flex flex-col gap-1">
            <div className="px-1.5 pb-1"><SectionTitle>{k.title}</SectionTitle></div>
            {all.filter((e) => e.kind === k.kind).map((e) => {
              const shown = edit?.id === e.id ? edit : e;
              const face = shown.kind === "person" || shown.kind === "place" ? shown.def.pictures[0] : undefined;
              return (
                <button key={e.id} type="button" aria-pressed={open === e.id} onClick={() => void flush().then(() => setOpen(e.id))} className={cx("flex h-12 items-center gap-2.5 rounded-lg px-1.5 text-left", open === e.id ? "bg-hover text-white" : "hover:bg-raised")}>
                  {face ? <img src={thumbUrl(face)} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" /> : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-raised text-ink-2">{k.icon}</span>}
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold">{shown.name}</span>
                    <span className="truncate text-xs text-ink-2">
                      {shown.kind === "person" ? `${shown.def.pictures.length} picture${shown.def.pictures.length === 1 ? "" : "s"}, ${shown.def.voice ? "1 voice" : "no voice"}, ${shown.def.outfits.length} outfit${shown.def.outfits.length === 1 ? "" : "s"}`
                        : shown.kind === "place" ? `${shown.def.pictures.length} picture${shown.def.pictures.length === 1 ? "" : "s"}`
                        : shown.kind === "style" ? `set up for ${Object.values(shown.def.models).filter((m) => m.loras.length || m.words.trim()).length} model${Object.values(shown.def.models).filter((m) => m.loras.length || m.words.trim()).length === 1 ? "" : "s"}` : ""}
                    </span>
                  </span>
                </button>
              );
            })}
            <button type="button" onClick={() => create.mutate(k.kind)} disabled={create.isPending} className="flex h-9 items-center gap-2 rounded-lg px-2.5 text-ink-2 hover:bg-raised hover:text-ink">
              <Plus size={14} /> {k.add}
            </button>
          </div>
        ))}
        {presets.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="px-1.5 pb-1"><SectionTitle>Presets and snippets</SectionTitle></div>
            {presets.map((e) => (
              <button key={e.id} type="button" aria-pressed={open === e.id} onClick={() => void flush().then(() => setOpen(e.id))} className={cx("flex h-10 items-center gap-2.5 rounded-lg px-2.5 text-left", open === e.id ? "bg-hover text-white" : "hover:bg-raised")}>
                <Bookmark size={14} className="shrink-0 text-ink-2" />
                <span className="truncate font-semibold">{edit?.id === e.id ? edit.name : e.name}</span>
              </button>
            ))}
          </div>
        )}
        {(entities.isError || create.isError) && <ErrorNote>{(entities.error ?? create.error)?.message}</ErrorNote>}
      </aside>

      <main className="min-w-0 grow overflow-y-auto">
        {!edit ? (
          <div className="p-8">
            <Empty title={all.length ? "Pick one on the left" : "People, places and styles"}>
              Written once, used with every model. A person is some pictures, a voice and a few words; studai gives each model what it can take: tags or a sentence, a LoRA, reference pictures, the voice. Add them to a picture, a video or a whole timeline with one click.
            </Empty>
          </div>
        ) : (
          <div className="flex max-w-3xl flex-col gap-5 p-6">
            <div className="flex items-center gap-3">
              <input aria-label="Name" value={edit.name} onChange={(e) => change({ ...edit, name: e.target.value })} className="h-11 min-w-0 grow rounded-lg border border-transparent bg-transparent px-2 text-xl font-semibold hover:border-line focus:border-accent focus:bg-raised" />
              <span className={cx("shrink-0 rounded-full px-2.5 py-0.5 text-[11px]", saved === "failed" ? "bg-warn-wash text-warn-ink" : "bg-raised text-ink-2")}>{saved === "saved" ? "Saved" : saved === "saving" ? "Saving…" : "Could not save"}</span>
              {removing ? (
                <>
                  <span className="text-xs text-ink-2">Its pictures stay in your library.</span>
                  <Button size="sm" tone="danger" onClick={() => remove.mutate(edit.id)}>Delete</Button>
                  <Button size="sm" tone="quiet" onClick={() => setRemoving(false)}>Cancel</Button>
                </>
              ) : (
                <button type="button" aria-label={`Delete ${edit.name}`} onClick={() => setRemoving(true)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><Trash2 size={15} /></button>
              )}
            </div>
            {edit.kind === "person" && <PersonEditor def={edit.def} name={edit.name || "this person"} onChange={(def) => change({ ...edit, def })} />}
            {edit.kind === "place" && <PlaceEditor def={edit.def} name={edit.name || "this place"} onChange={(def) => change({ ...edit, def })} />}
            {edit.kind === "style" && <StyleEditor def={edit.def} onChange={(def) => change({ ...edit, def })} />}
            {edit.kind === "snippet" && (
              <label className="flex flex-col gap-1.5">
                <span className="text-ink-2">A bit of text kept to drop into what you write, from "Snippets" above a form.</span>
                <AutoText rows={3} value={edit.def.text} onChange={(e) => change({ ...edit, def: { text: e.target.value } })} className={field} />
              </label>
            )}
            {edit.kind === "preset" && (
              <div className="flex flex-col gap-2 text-ink-2">
                <span>A whole setup kept under a name: the model, its form, and who is in it. Use it from Create, under "Made with".</span>
                <span>Model: <span className="text-ink">{recipes.data?.recipes.find((r) => r.id === edit.def.recipe)?.title ?? "a model that is no longer here"}</span></span>
                <span>Settings kept: <span className="text-ink">{Object.keys(edit.def.inputs).length}</span></span>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
