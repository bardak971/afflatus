import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Music, Plus, Trash2, X } from "lucide-react";
import { LIMITS } from "@afflatus/core";
import { api, thumbUrl, type Outfit, type PersonDef, type PlaceDef } from "../../api";
import { AudioPlayer } from "../../AudioPlayer";
import { SoundRange } from "../../SoundRange";
import { DRAG_HAS_SOUND, DRAG_PICTURE, DRAG_SOUND, DRAG_TYPE, useDropZone } from "../../dragging";
import { useAsset, useRecipes, useSetup } from "../../data";
import { Viewer } from "../../viewer/LazyViewer";
import { useLoraWordsOf } from "../../fields";
import { fileLabel, plural } from "../../format";
import { Picker } from "../../PictureField";
import { ModelLink } from "../../ModelLink";
import { Card, Row } from "../../Rows";
import { Select } from "../../Select";
import { localId } from "../../secureContext";
import { AutoText, Button, cx, NumberBox } from "../../ui";
import { Slider } from "../../Slider";
import { dropped, moved } from "../queue/order";
import { useFlip } from "../../useFlip";
import { entryOf, field, modelRows, outfitsOf, withEntry } from "./shared";
import { queryKeys } from "../../queryKeys";

/** A small fact of a row: what a model takes of the person. */
function Takes({ children, tip }: { children: string; tip: string }) {
  return <span data-tip={tip} className="rounded-md bg-raised px-1.5 py-px text-[10.5px] whitespace-nowrap text-ink-2">{children}</span>;
}

/**
 * The pictures of a person or a place: a row to add to, take from and put in order (dragged, or Alt + arrow on a
 * focused one). The first `sent` are what a model is handed, marked by a bar above them; a person's first is the face.
 */
function Pictures({ value, onChange, what, sent, face }: { value: string[]; onChange(value: string[]): void; what: string; sent: number; face?: boolean }) {
  const [picking, setPicking] = useState(false);
  // a click shows the picture large
  const [open, setOpen] = useState<string | null>(null);
  const shown = useAsset(open);
  // a picture of the row being dragged to another place in it, and where it would go (before the picture of that index)
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  // a picture moved from the keyboard keeps the focus once the row is redrawn
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [refocus, setRefocus] = useState<string | null>(null);
  // a picture moved (dropped, Alt + arrow) slides to its place and the others step aside; the row changes only on
  // the drop, so nothing moves under the browser's drag picture
  const flip = useFlip(value);
  useEffect(() => {
    if (!refocus) return;
    buttons.current.get(refocus)?.focus();
    setRefocus(null);
  }, [refocus, value]);
  // pictures dropped on the row: files from the computer (kept with them, not put in the library) or pictures dragged from the library, several at once
  const room = LIMITS.pictures - value.length;
  const add = useMutation({
    mutationFn: async (dropped: { files: File[]; ids: string[] }) => {
      const made: string[] = [];
      for (const f of dropped.files.filter((f) => f.type.startsWith("image/")).slice(0, room)) made.push((await api.upload(f, { kit: true })).id);
      return [...dropped.ids, ...made];
    },
    onSuccess: (ids) => onChange([...value, ...ids.filter((id, i) => !value.includes(id) && ids.indexOf(id) === i)].slice(0, LIMITS.pictures)),
  });
  const drop = useDropZone([DRAG_PICTURE], () => {}, () => {});
  const onDrop = (e: DragEvent) => {
    // one of the row put in another place
    if (dragged) {
      e.preventDefault();
      if (over !== null) onChange(dropped(value, dragged, over));
      setDragged(null);
      setOver(null);
      return;
    }
    if (room <= 0) return;
    e.preventDefault();
    drop.props.onDragLeave();
    const files = [...e.dataTransfer.files];
    const ids = files.length ? [] : e.dataTransfer.getData(DRAG_TYPE).split(",").filter(Boolean).slice(0, room);
    if (files.length || ids.length) add.mutate({ files, ids });
  };
  const onKey = (e: KeyboardEvent, id: string, i: number) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    // Alt + ← is also the browser's Back
    e.preventDefault();
    const to = e.key === "ArrowLeft" ? i - 1 : i + 1;
    if (to < 0 || to >= value.length) return;
    onChange(moved(value, id, to));
    setRefocus(id);
  };
  const first = Math.min(sent, value.length);
  return (
    <div className={cx("px-4 py-3", first > 0 && "pt-7")}>
      <div
        {...drop.props}
        onDragOver={(e) => (dragged ? e.preventDefault() : drop.props.onDragOver(e))}
        onDrop={onDrop}
        className={cx("relative -m-1 flex flex-wrap gap-2 rounded-2xl border-[1.5px] border-transparent p-1", room > 0 && !dragged && drop.zone)}
      >
        {first > 0 && (
          // the pictures a model is handed: a bar over them, as wide as they are
          <span aria-hidden className="pointer-events-none absolute -top-[19px] left-1 flex flex-col gap-1" style={{ width: first * 84 + (first - 1) * 8 }}>
            {/* on one line whatever the bar's width: over a single picture it wrapped, and the second line ran into it */}
            <span className="text-[10.5px] leading-none font-bold whitespace-nowrap text-accent">sent to the models</span>
            <span className="h-[3px] rounded-full bg-accent" />
          </span>
        )}
        {value.map((id, i) => (
          <div
            key={id}
            ref={flip(id)}
            draggable={value.length > 1}
            onDragStart={(e) => {
              // a drag of its own: it carries no picture of the library, so that no other place takes it
              e.dataTransfer.effectAllowed = "move";
              setDragged(id);
            }}
            onDragEnd={() => {
              setDragged(null);
              setOver(null);
            }}
            onDragOver={(e) => {
              if (!dragged) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const r = e.currentTarget.getBoundingClientRect();
              setOver(e.clientX < r.left + r.width / 2 ? i : i + 1);
            }}
            className={cx("relative", value.length > 1 && "cursor-grab", dragged === id ? "opacity-40" : i >= first && "opacity-55")}
          >
            {dragged && over === i && <span className="absolute top-0 -left-[6px] h-full w-1 rounded-full bg-accent" />}
            {dragged && over === i + 1 && i === value.length - 1 && <span className="absolute top-0 -right-[6px] h-full w-1 rounded-full bg-accent" />}
            <button
              ref={(el) => {
                if (el) buttons.current.set(id, el);
                else buttons.current.delete(id);
              }}
              type="button"
              aria-label={`Show image ${i + 1} of ${what} large${face && i === 0 ? ", the face" : ""}`}
              aria-keyshortcuts={value.length > 1 ? "Alt+ArrowLeft Alt+ArrowRight" : undefined}
              onClick={() => setOpen(id)}
              onKeyDown={(e) => onKey(e, id, i)}
              className="block cursor-zoom-in rounded-[10px]"
            >
              <img src={thumbUrl(id)} alt="" draggable={false} className="h-[84px] w-[84px] rounded-[10px] border border-line object-cover hover:border-accent" />
            </button>
            <span className={cx("pointer-events-none absolute bottom-1 left-1 rounded-[5px] px-1.5 text-[10.5px] font-bold", face && i === 0 ? "bg-accent text-ground" : "bg-ground/80 text-ink")}>{face && i === 0 ? "face" : i + 1}</span>
            <button type="button" aria-label="Remove this image" onClick={() => onChange(value.filter((x) => x !== id))} className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-ground/85 text-ink-2 hover:text-ink"><X size={11} /></button>
          </div>
        ))}
        {value.length < LIMITS.pictures && (
          <button type="button" aria-label={`Add a reference image of ${what}`} data-tip="Or drop pictures here, from the computer or the library" onClick={() => setPicking(true)} className="flex h-[84px] w-[84px] flex-col items-center justify-center gap-1 rounded-[10px] border-[1.5px] border-dashed border-line-strong text-ink-2 hover:text-ink">
            <Plus size={16} />
            <span className="text-xs">{add.isPending ? "Adding…" : "Add"}</span>
          </button>
        )}
        {add.isError && <span className="basis-full text-xs text-warn-ink">{add.error.message}</span>}
        {/* a file from the computer is kept with the person or place, not put in the library; one picked from the library stays there too */}
        {picking && <Picker kit title={`A reference image of ${what}`} onClose={() => setPicking(false)} onPick={(id) => { if (!value.includes(id)) onChange([...value, id]); setPicking(false); }} />}
        {shown.data && <Viewer asset={shown.data} onClose={() => setOpen(null)} />}
      </div>
    </div>
  );
}

/**
 * The part of a voice sample a model takes: 2 to 15 seconds (H3's voice sample, the only model that takes one yet), 8 when
 * none is set (the form's usual length; the owner's 8 s vs 15 s test will say which is better).
 */
const VOICE_PART = { min: 2, most: 15, usual: 8 };

/**
 * The voice sample, as one row: its player with Change and Remove, or a slot to choose or drop one in; under it, the part
 * the models are given, on its waveform.
 */
function Voice({ value, part, onChange, onPart }: {
  value: string | null;
  part: { start: number; seconds: number } | null;
  onChange(value: string | null): void;
  onPart(part: { start: number; seconds: number }): void;
}) {
  const [picking, setPicking] = useState(false);
  const asset = useAsset(value);
  const total = asset.data?.durationMs ? asset.data.durationMs / 1000 : null;
  const shown = part ?? { start: 0, seconds: Math.min(VOICE_PART.usual, total ?? VOICE_PART.usual) };
  // a sound file from the computer is kept with the person, as their pictures are: not put in the library
  const upload = useMutation({
    mutationFn: (file: File) => api.upload(file, { kit: true }),
    onSuccess: (a) => onChange(a.id),
  });
  // a sound of the library, or a video that has sound
  const drop = useDropZone([DRAG_SOUND, DRAG_HAS_SOUND], onChange, (file) => file.type.startsWith("audio/") && upload.mutate(file));
  return (
    <div className="flex min-w-0 grow flex-col gap-1">
      {value ? (
        <div {...drop.props} className={cx("flex min-w-0 items-center gap-2 rounded-xl border bg-raised py-1 pr-1.5 pl-2", drop.over ? "border-accent bg-accent-wash" : drop.wanted ? "border-dashed border-accent" : "border-line")}>
          {/* the part the models are given, played on the whole sample's waveform where it is chosen */}
          <AudioPlayer
            asset={value} name={asset.data?.name || "Audio"} range={{ from: shown.start, to: shown.start + shown.seconds }} bare className="min-w-0 grow"
            strip={total !== null && total > VOICE_PART.min ? (now, playFrom) => (
              <SoundRange asset={value} total={total} start={shown.start} seconds={shown.seconds} min={VOICE_PART.min} most={VOICE_PART.most} label="Voice sample: the part used" playhead={now} onSeek={playFrom} onCommit={(start, seconds) => onPart({ start, seconds })} />
            ) : undefined}
          >
            <Button size="sm" onClick={() => setPicking(true)}>Change</Button>
            <Button size="sm" onClick={() => onChange(null)}>Remove</Button>
          </AudioPlayer>
        </div>
      ) : (
        <button type="button" {...drop.props} onClick={() => setPicking(true)} className={cx("flex h-8 min-w-0 items-center gap-2 rounded-[9px] border border-dashed px-2.5 text-[12.5px] text-ink-2 hover:text-ink", drop.zone || "border-line-strong")}>
          <Music size={14} className="shrink-0" />
          <span className="truncate">{upload.isPending ? "Adding…" : "Choose or drop an audio file"}</span>
        </button>
      )}
      {upload.isError && <span className="text-xs text-warn-ink">{upload.error.message}</span>}
      {picking && <Picker title="Voice sample" kind="audio" onClose={() => setPicking(false)} onPick={(id) => { onChange(id); setPicking(false); }} />}
    </div>
  );
}

const WORDS_HELP = "Some models read danbooru tags, others natural-language prompts. Afflatus uses the one the model needs.";

/** The prompt text of a person or a place: tags and natural language, one row each. */
function Words({ tags, sentence, onChange, place }: { tags: string; sentence: string; onChange(patch: { tags?: string; sentence?: string }): void; place?: boolean }) {
  const id = useId();
  return (
    <Card dense title="Prompt text" help={WORDS_HELP}>
      <Row label="Tags" htmlFor={`${id}-tags`}>
        <AutoText id={`${id}-tags`} rows={1} value={tags} placeholder={place ? "forest, morning fog, dirt path" : "brown hair, green eyes, freckles"} onChange={(e) => onChange({ tags: e.target.value })} className={field} />
      </Row>
      <Row label="Natural language" htmlFor={`${id}-nl`}>
        <AutoText id={`${id}-nl`} rows={1} value={sentence} placeholder={place ? "A forest path in the morning fog." : "She has brown hair, green eyes and freckles."} onChange={(e) => onChange({ sentence: e.target.value })} className={field} />
      </Row>
    </Card>
  );
}

/** The picture of an outfit: a small square to choose, drop or remove it; a click on it shows it large. */
function OutfitPicture({ value, onChange, what }: { value: string | null; onChange(value: string | null): void; what: string }) {
  const client = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState(false);
  const shown = useAsset(open ? value : null);
  // a file from the computer is kept with the person, not put in the library
  const upload = useMutation({
    mutationFn: (file: File) => api.upload(file, { kit: true }),
    onSuccess: (a) => {
      void client.invalidateQueries({ queryKey: queryKeys.assets.all() });
      onChange(a.id);
    },
  });
  const drop = useDropZone([DRAG_PICTURE], onChange, (file) => file.type.startsWith("image/") && upload.mutate(file));
  return (
    <div {...drop.props} className="relative h-9 w-9">
      {value ? (
        <>
          <button type="button" aria-label={`Show the picture of ${what} large`} onClick={() => setOpen(true)} className={cx("block cursor-zoom-in rounded-lg border", drop.over || drop.wanted ? "border-accent" : "border-line")}>
            <img src={thumbUrl(value)} alt="" className="h-[34px] w-[34px] rounded-lg object-cover" />
          </button>
          <button type="button" aria-label={`Remove the picture of ${what}`} onClick={() => onChange(null)} className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-ground text-ink-2 hover:text-ink"><X size={10} /></button>
        </>
      ) : (
        <button type="button" aria-label={`Choose a picture of ${what}`} data-tip="A reference image of the clothes: choose one, or drop it here" onClick={() => setPicking(true)} className={cx("flex h-9 w-9 items-center justify-center rounded-lg border-[1.5px] border-dashed text-ink-3 hover:text-ink", drop.zone || "border-line-strong")}>
          {upload.isPending ? <span className="text-[10px]">…</span> : <Plus size={13} />}
        </button>
      )}
      {picking && <Picker kit title={`A reference image of ${what}`} onClose={() => setPicking(false)} onPick={(id) => { onChange(id); setPicking(false); }} />}
      {shown.data && <Viewer asset={shown.data} onClose={() => setOpen(false)} />}
    </div>
  );
}

export function PersonEditor({ def, name, onChange }: { def: PersonDef; name: string; onChange(def: PersonDef): void }) {
  const recipes = useRecipes();
  const setup = useSetup();
  const rows = modelRows(recipes.data?.families ?? [], recipes.data?.recipes ?? []);
  // the LoRAs of every family of a row, each once
  const lorasOf = (ids: string[]) => [...new Set(ids.flatMap((family) => setup.data?.recipes.find((s) => recipes.data?.recipes.find((r) => r.id === s.id)?.family === family && s.options.loras)?.options.loras ?? []))];
  const setOutfit = (id: string, patch: Partial<Outfit>) => onChange({ ...def, outfits: def.outfits.map((o) => (o.id === id ? { ...o, ...patch } : o)) });
  // the words that call the person's LoRAs up, as their files or their pages give them: offered where none is written
  const words = useLoraWordsOf(Object.values(def.models).flatMap((m) => (m.lora ? [m.lora] : [])));
  const full = def.outfits.length >= LIMITS.outfits;
  return (
    <Halves>
      <div className="flex min-w-0 flex-col gap-3">
        <Card dense title={`Reference images · ${def.pictures.length}`} status={def.pictures.length > 1 && <span className="text-[11.5px] text-ink-3">drag to reorder</span>} help={`Used by models that take reference images: the first ${LIMITS.sentPictures.person} are sent, the first being the face. Two or three angles hold a face better than one. Drop pictures on the row, from the computer or the library; drag one, or Alt + ← → on a focused one, to change the order.`}>
          <Pictures value={def.pictures} onChange={(pictures) => onChange({ ...def, pictures })} what={name} sent={LIMITS.sentPictures.person} face />
          <Row label="Voice sample" help="A few seconds of them speaking. Models that generate audio give the person this voice. Under it, the part they are given, in the accent: drag on the waveform for another part, its ends snap to the pauses (Alt: anywhere); a click plays from there. Optional.">
            {/* the part belongs to the sample: another sample starts from the form's own part again */}
            <Voice value={def.voice} part={def.voicePart ?? null} onChange={(voice) => onChange({ ...def, voice, voicePart: null })} onPart={(voicePart) => onChange({ ...def, voicePart })} />
          </Row>
        </Card>

        <Words tags={def.tags} sentence={def.sentence} onChange={(p) => onChange({ ...def, ...p })} />
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <Card dense title="LoRA per model" status={<span className="text-[11.5px] text-ink-3">optional</span>} help={`A LoRA is a file you already have: Afflatus does not train one. The chips say what each model takes of ${name}: reference images, tags or natural language, the voice sample. A model that takes neither reference images nor a LoRA gets only the prompt text.`}>
          {rows.map(({ family: f, ids, can }) => {
            const m = entryOf(def.models, ids) ?? { lora: null, weight: 0.8, trigger: "" };
            const set = (patch: Partial<typeof m>) => onChange({ ...def, models: withEntry(def.models, ids, { ...m, ...patch }) });
            const refs = Math.min(LIMITS.sentPictures.person, def.pictures.length);
            const known = can.tags && m.lora && !m.trigger.trim() ? words.of(m.lora) : null;
            return (
              // the mock's three columns: the family, what it takes, its LoRA (and under that, the LoRA's weight and words)
              <div key={f.id} className="grid min-h-[48px] grid-cols-[150px_128px_minmax(0,1fr)] items-start gap-x-3.5 gap-y-1.5 px-4 py-2">
                <span className="flex h-8 min-w-0 items-center truncate text-[13px] font-semibold">{f.name}</span>
                <span className="flex h-8 flex-wrap content-center items-center gap-1">
                  {can.pictures && refs > 0 && <Takes tip={`${plural(refs, "reference image")} of ${name}`}>{`${plural(refs, "ref")}`}</Takes>}
                  <Takes tip={can.tags ? "Reads the tags" : "Reads the natural language"}>{can.tags ? "tags" : "NL"}</Takes>
                  {can.voice && def.voice && <Takes tip="Takes the voice sample">voice</Takes>}
                </span>
                {can.lora ? (
                  <Select
                    size="sm"
                    label={`LoRA of ${name} for ${f.name}`}
                    value={m.lora ?? ""}
                    onChange={(file) => set({ lora: file || null })}
                    searchHint="Search your LoRAs by name"
                    options={[{ value: "", label: "No LoRA" }, ...lorasOf(ids).map((file) => ({ value: file, label: fileLabel(file), note: file.split(/[\/]/).slice(0, -1).join("/") }))]}
                  />
                ) : (
                  <span className="flex h-8 items-center text-xs text-ink-3">{can.pictures ? "takes no LoRA" : "prompt text only"}</span>
                )}
                {can.lora && m.lora && (
                  <div className="col-start-3 flex min-w-0 items-center gap-2">
                    <Slider label={`Weight of the LoRA of ${name} for ${f.name}`} min={-1} max={2} step={0.05} zero={0} box={false} value={Math.max(-1, Math.min(2, m.weight))} onChange={(v) => set({ weight: v })} className="w-24 shrink-0" />
                    <NumberBox label={`Weight of the LoRA of ${name} for ${f.name}, typed`} value={m.weight} min={-4} max={4} step={0.05} onCommit={(v) => set({ weight: v })} />
                    {can.tags && <input aria-label={`Trigger words for ${f.name}`} placeholder="Trigger words" value={m.trigger} onChange={(e) => set({ trigger: e.target.value })} className={cx(field, "h-8 min-w-0 grow py-0 text-[12.5px]")} />}
                  </div>
                )}
                {can.lora && m.lora && (
                  <div className="col-start-3 flex min-w-0 items-baseline gap-3 text-xs text-ink-2">
                    <span className="flex min-w-0 shrink-0 items-baseline gap-1.5">Model page <ModelLink folder="loras" file={m.lora} className="min-w-0" /></span>
                    {known?.words && known.from !== "training" && (
                      <button type="button" onClick={() => set({ trigger: known.words.slice(0, 200) })} className="min-w-0 truncate text-left text-accent hover:underline" data-tip={known.words}>
                        Use its trigger words: {known.words}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </Card>

        <Card
          dense
          title={`Outfits · ${outfitsOf(def.outfits).length}`}
          help={`Pick one when you add ${name} to an image or a clip. Each has prompt text (tags and natural language) and, if you like, a reference image of the clothes. Without an outfit, ${name} is "as in the reference images": nothing about clothes is added to the prompt.`}
          status={
            // as many as a person holds: the server refuses more, and the person would no longer save
            <Button size="sm" tone="quiet" disabled={full} data-tip={full ? `${LIMITS.outfits} outfits is the most a person holds` : undefined} onClick={() => onChange({ ...def, outfits: [...def.outfits, { id: localId(), name: "", tags: "", sentence: "", picture: null }] })} className="h-[26px] gap-1"><Plus size={13} /> Outfit</Button>
          }
        >
          {def.outfits.map((o) => (
            <div key={o.id} className="grid grid-cols-[36px_140px_minmax(0,1fr)_auto] items-start gap-3 px-4 py-2.5">
              <OutfitPicture value={o.picture} onChange={(picture) => setOutfit(o.id, { picture })} what={o.name || "the outfit"} />
              <input aria-label="Name of the outfit" value={o.name} placeholder="Outfit name" onChange={(e) => setOutfit(o.id, { name: e.target.value })} className={cx(field, "h-9 py-0 font-semibold")} />
              <div className="flex min-w-0 flex-col gap-1.5">
                <AutoText rows={1} aria-label="The outfit as tags" value={o.tags} placeholder="Tags: white summer dress" onChange={(e) => setOutfit(o.id, { tags: e.target.value })} className={cx(field, "py-1.5 text-[12.5px]")} />
                <AutoText rows={1} aria-label="The outfit in natural language" value={o.sentence} placeholder="Natural language: She wears a white summer dress." onChange={(e) => setOutfit(o.id, { sentence: e.target.value })} className={cx(field, "py-1.5 text-[12.5px]")} />
              </div>
              <button type="button" aria-label={`Remove the outfit ${o.name}`} onClick={() => onChange({ ...def, outfits: def.outfits.filter((x) => x.id !== o.id) })} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><Trash2 size={14} /></button>
            </div>
          ))}
        </Card>
      </div>
    </Halves>
  );
}

export function PlaceEditor({ def, name, onChange }: { def: PlaceDef; name: string; onChange(def: PlaceDef): void }) {
  return (
    <Halves>
      <Card dense title={`Reference images · ${def.pictures.length}`} status={def.pictures.length > 1 && <span className="text-[11.5px] text-ink-3">drag to reorder</span>} help={`Used by models that take reference images: the clip happens there. The first ${LIMITS.sentPictures.place} are sent. Drop pictures on the row, from the computer or the library; drag one, or Alt + ← → on a focused one, to change the order.`}>
        <Pictures value={def.pictures} onChange={(pictures) => onChange({ ...def, pictures })} what={name} sent={LIMITS.sentPictures.place} />
      </Card>
      <Words place tags={def.tags} sentence={def.sentence} onChange={(p) => onChange({ ...def, ...p })} />
    </Halves>
  );
}

/**
 * An editor in two columns side by side once the kit's editor column is wide (People.tsx makes it the `editor`
 * container), one under the other below that: on a wide screen the right half is used rather than left empty. What
 * an item holds never moves the split, so going from one item to the next does not shift the page.
 */
function Halves({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 items-start gap-3 @[1100px]/editor:grid-cols-2">{children}</div>;
}
