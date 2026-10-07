import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { thumbUrl, type Outfit, type PersonDef, type PlaceDef } from "../../api";
import { useAsset, useRecipes, useSetup } from "../../data";
import { Viewer } from "../../Viewer";
import { useLoraWordsOf } from "../../fields";
import { fileLabel } from "../../format";
import { Picker, PictureField, SoundField } from "../../PictureField";
import { ModelLink } from "../../ModelLink";
import { Select } from "../../Select";
import { AutoText, Button, cx, NumberBox, SectionTitle } from "../../ui";
import { field, takes } from "./shared";

/** The pictures of a person or a place: a row to add to and take from. */
function Pictures({ value, onChange, what }: { value: string[]; onChange(value: string[]): void; what: string }) {
  const [picking, setPicking] = useState(false);
  // a click shows the picture large
  const [open, setOpen] = useState<string | null>(null);
  const shown = useAsset(open);
  return (
    <div className="flex flex-wrap gap-2">
      {value.map((id, i) => (
        <div key={id} className="relative">
          <button type="button" aria-label={`Show image ${i + 1} of ${what} large`} onClick={() => setOpen(id)} className="block cursor-zoom-in rounded-lg">
            <img src={thumbUrl(id)} alt="" className="h-28 w-24 rounded-lg border border-line object-cover hover:border-accent" />
          </button>
          <button type="button" aria-label="Remove this image" onClick={() => onChange(value.filter((x) => x !== id))} className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-ground/85 text-ink-2 hover:text-ink"><X size={11} /></button>
        </div>
      ))}
      {value.length < 9 && (
        <button type="button" aria-label={`Add a reference image of ${what}`} onClick={() => setPicking(true)} className="flex h-28 w-24 flex-col items-center justify-center gap-1 rounded-lg border-[1.5px] border-dashed border-line-strong text-ink-2 hover:text-ink">
          <Plus size={16} />
          <span className="text-xs">Add image</span>
        </button>
      )}
      {/* a file from the computer is kept with the person or place, not put in the library; one picked from the library stays there too */}
      {picking && <Picker kit title={`A reference image of ${what}`} onClose={() => setPicking(false)} onPick={(id) => { if (!value.includes(id)) onChange([...value, id]); setPicking(false); }} />}
      {shown.data && <Viewer asset={shown.data} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Words({ tags, sentence, onChange, who }: { tags: string; sentence: string; onChange(patch: { tags?: string; sentence?: string }): void; who: string }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{who}, as prompt text</SectionTitle>
      <span className="text-ink-2">Some models read danbooru tags, others natural-language prompts. Afflatus uses the one the model needs.</span>
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

export function PersonEditor({ def, name, onChange }: { def: PersonDef; name: string; onChange(def: PersonDef): void }) {
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
        <span className="text-ink-2">A LoRA is optional. It is a file you already have: Afflatus does not train one.</span>
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
                      <input type="range" min={-1} max={2} step={0.05} value={Math.max(-1, Math.min(2, m.weight))} onChange={(e) => set({ weight: Number(e.target.value) })} className="w-24" />
                      <NumberBox label={`Weight of the LoRA of ${name} for ${f.name}, typed`} value={m.weight} min={-4} max={4} step={0.05} onCommit={(v) => set({ weight: v })} />
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
            <PictureField kit label="Reference image of the clothes" optional value={o.picture} onChange={(picture) => setOutfit(o.id, { picture: picture ?? null })} />
          </div>
        ))}
        <span><Button size="sm" onClick={() => onChange({ ...def, outfits: [...def.outfits, { id: crypto.randomUUID(), name: "", tags: "", sentence: "", picture: null }] })}><Plus size={13} /> New outfit</Button></span>
        <span className="text-xs text-ink-3">Without an outfit, {name} is "as in the reference images": nothing about clothes is added to the prompt.</span>
      </div>
    </>
  );
}

export function PlaceEditor({ def, name, onChange }: { def: PlaceDef; name: string; onChange(def: PlaceDef): void }) {
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
