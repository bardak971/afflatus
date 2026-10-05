import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Check, ChevronDown, Copy, Minus, Pencil, Plus, X } from "lucide-react";
import { baseGroup, baseLabel, lineOf, loraFit, modelFit, pickChoice, type ClipValue, type InputSpec, type LoraValue, type ReferenceValue, type SizeValue, frameOf, megapixels, sameBase } from "@afflatus/core";
import { api, type FamilyInfo, type ModelInfo, type ModelWords, type TagIssue } from "./api";
import { useModelInfo, useModelWords, useSettings, useModelUpdates } from "./data";
import { fileLabel } from "./format";
import { MaskField } from "./MaskField";
import { ClipField, PictureField, ReferencesField, SoundField } from "./PictureField";
import { Popover } from "./Popover";
import { appendTo, nudgeWeight, removeFrom, replaceTag, wordsIn } from "./promptText";
import { Select, type Option } from "./Select";
import { AutoText, cx, NumberBox, Segmented, Toggle, Help, Note } from "./ui";
import { ModelLink } from "./ModelLink";
import { useExplain } from "./store";
import { useSeedMode, type SeedMode } from "./seedMode";

/**
 * One control per input type. This file is the only place that knows how an input is drawn: a recipe
 * only says which inputs it has, so a new recipe needs nothing here.
 */

const RANDOM_SEED = -1;
const field = "w-full rounded-lg border border-line bg-raised px-3 text-ink placeholder:text-ink-3";

/** The value an input starts with, given what this ComfyUI offers for it. */
export function defaultOf(spec: InputSpec, options: string[] | undefined): unknown {
  switch (spec.type) {
    // an example is shown, not filled in
    case "prompt": return spec.example ? "" : spec.default ?? "";
    case "model": return options?.[0] ?? "";
    case "loras": return spec.default ?? [];
    case "size": {
      const s = spec.shapes.find((x) => x.id === spec.default) ?? spec.shapes[0]!;
      return { width: s.width, height: s.height };
    }
    case "number":
    case "toggle": return spec.default;
    // a file choice starts on a file this ComfyUI has
    case "choice": return pickChoice(spec, options);
    case "seed": return RANDOM_SEED;
    case "image": return undefined;
    case "clip": return undefined;
    case "references": return [];
    case "audio": return undefined;
  }
}

/** A file's name as the words kept for it are filed under: lower case, without its sub-folder. */
const nameOf = (file: string) => (file.split(/[\\/]/).pop() ?? file).toLowerCase();

/**
 * The words that call a LoRA up, and where they are from: the user's own first, then what its author
 * wrote in the file, then what its page on Civitai gives, or else the words it was trained with most.
 */
function wordsOf(info: ModelInfo | undefined, more?: ModelWords): { words: string; from: "own" | "file" | "page" | "training" | null } {
  if (more?.own) return { words: more.own, from: "own" };
  if (info?.trigger) return { words: info.trigger, from: "file" };
  if (more?.found) return { words: more.found, from: "page" };
  const trained = info?.tags?.slice(0, 8).join(", ") ?? "";
  return { words: trained, from: trained ? "training" : null };
}
const FROM = { own: "Your words for it", file: "Its trigger words", page: "Its trigger words, from its page on Civitai", training: "The words it was trained with most" };

/** The trigger words of the LoRAs a form has in use: words that are no danbooru tags and are right all the same. */
function useLoraWords(values: Record<string, unknown> | undefined): string[] {
  const info = useModelInfo("loras").data?.items;
  const more = useModelWords("loras").data?.items;
  return useMemo(() => {
    const loras = Object.values(values ?? {}).filter((v): v is LoraValue[] => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof (x as LoraValue).file === "string" && typeof (x as LoraValue).weight === "number")).flat();
    return loras.map((l) => wordsOf(info?.[l.file], more?.[nameOf(l.file)])).filter((w) => w.from && w.from !== "training").map((w) => w.words);
  }, [values, info, more]);
}

/**
 * Under a prompt written in tags: one short line when some of its tags are not danbooru tags (what anime
 * models learned). It opens a list: another name of a tag and a typo are put right with a click, the
 * rest are only named. Looked at a moment after the typing stops; nothing when every tag is known.
 */
function TagCheck({ text, ignore, onChange }: { text: string; ignore: string[]; onChange(text: string): void }) {
  const [issues, setIssues] = useState<TagIssue[]>([]);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const ignoreKey = ignore.join("|");
  useEffect(() => {
    if (!text.trim()) return setIssues([]);
    let alive = true;
    const wait = setTimeout(() => {
      api.checkTags(text, ignoreKey ? ignoreKey.split("|") : []).then((r) => alive && setIssues(r.issues), () => {});
    }, 700);
    return () => {
      alive = false;
      clearTimeout(wait);
    };
  }, [text, ignoreKey]);
  if (!issues.length) return null;
  const fixable = issues.filter((i) => i.suggestion);
  const plain = issues.filter((i) => !i.suggestion);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title="Anime models learned danbooru's tags: another word does little, a typo nothing"
        className="flex items-center gap-1 self-start rounded-md text-xs text-warn-ink hover:underline"
      >
        {issues.length} tag{issues.length > 1 ? "s are" : " is"} not on danbooru's list{fixable.length ? ` · ${fixable.length} to fix` : ""}
        <ChevronDown size={12} />
      </button>
      {open && (
        <Popover anchor={button} onClose={() => setOpen(false)} label="Tags that are not danbooru tags" width={340} height={320}>
          <div className="flex flex-col gap-2 overflow-y-auto p-3">
            {fixable.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-ink-2">Written another way on danbooru</span>
                  {fixable.length > 1 && (
                    <button type="button" className="text-xs text-accent hover:underline" onClick={() => onChange(fixable.reduce((t, i) => replaceTag(t, i.tag, i.suggestion!), text))}>Fix all {fixable.length}</button>
                  )}
                </div>
                {fixable.map((i) => (
                  <button
                    key={i.tag}
                    type="button"
                    title={i.status === "alias" ? `"${i.tag}" is another name of the tag "${i.suggestion}"` : `Did you mean "${i.suggestion}"?`}
                    onClick={() => onChange(replaceTag(text, i.tag, i.suggestion!))}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-hover"
                  >
                    <span className="min-w-0 truncate text-ink-2 line-through">{i.tag}</span>
                    <span className="shrink-0 text-ink-3">→</span>
                    <span className="min-w-0 grow truncate font-semibold">{i.suggestion}</span>
                    <span className="shrink-0 text-xs text-accent">{i.status === "alias" ? "Use it" : "Fix"}</span>
                  </button>
                ))}
              </div>
            )}
            {plain.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-ink-2">Not danbooru tags: the model may mostly ignore them</span>
                <div className="flex flex-wrap gap-1">
                  {plain.map((i) => <span key={i.tag} className="rounded bg-raised px-1.5 py-0.5 text-xs text-ink-2">{i.tag}</span>)}
                </div>
              </div>
            )}
            <span className="text-xs text-ink-3">A LoRA's trigger words and plain sentences are left alone. The check can be turned off in Settings.</span>
          </div>
        </Popover>
      )}
    </>
  );
}

/**
 * A text box of a prompt. Ctrl + ↑ / ↓ changes the weight of the tag the cursor is in, or of what is
 * selected: (red dress:1.1). In a prompt of sentences only a selection is weighed.
 */
function PromptField({ spec, id, value, values, onChange }: { spec: Extract<InputSpec, { type: "prompt" }>; id: string; value: string; values?: Record<string, unknown>; onChange(value: string): void }) {
  const settings = useSettings();
  const checked = spec.style === "tags" && !spec.optional && Boolean(settings.data?.tagCheck);
  const ignore = useLoraWords(checked ? values : undefined);
  const weighs = spec.weights !== false;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} note={spec.note}>{spec.label}</Label>
      <AutoText
        id={id}
        rows={spec.optional && !spec.example ? 2 : 4}
        value={value}
        placeholder={spec.placeholder}
        title={weighs ? `Ctrl + ↑ or ↓: the weight of ${spec.style === "tags" ? "the tag the cursor is in, or of " : ""}what is selected. {a|b|c}: one is picked for each result.` : "{a|b|c}: one is picked for each result."}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (!weighs || !(e.ctrlKey || e.metaKey) || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          const el = e.currentTarget;
          const next = nudgeWeight(el.value, el.selectionStart, el.selectionEnd, e.key === "ArrowUp" ? 0.1 : -0.1, spec.style === "tags");
          if (!next) return;
          e.preventDefault();
          onChange(next.text);
          // once the new text is in the box, the tag is selected again: the next press goes on from it
          requestAnimationFrame(() => el.setSelectionRange(next.start, next.end));
        }}
        className={cx(field, "py-2.5 leading-normal", spec.optional && !spec.example ? "text-[13px]" : "text-sm")}
      />
      {checked && <TagCheck text={value} ignore={ignore} onChange={onChange} />}
    </div>
  );
}

/**
 * A file as a choice: its name to read, beside it the model it is for and the folder it is in. It is
 * found by everything the file says about itself, shown or not.
 */
const fileOption = (file: string, info?: ModelInfo): Option => {
  const folder = file.split(/[\\/]/).slice(0, -1).join("/");
  const note = [info?.base, folder].filter(Boolean).join(" · ");
  const search = [info?.title, info?.trainedOn, info?.trigger, info?.tags?.join(" "), info?.about].filter(Boolean).join(" ");
  return { value: file, label: fileLabel(file), ...(note ? { note } : {}), ...(search ? { search } : {}) };
};

/** The ComfyUI model folder behind a node input that picks a file, for the inputs whose name says it. */
const FOLDER_OF: Record<string, string> = {
  ckpt_name: "checkpoints", unet_name: "diffusion_models", vae_name: "vae", clip_name: "text_encoders", lora_name: "loras", control_net_name: "controlnet",
};

/** A dropdown of model files, searched by what the files say about themselves when their folder is known. */
function FileSelect({ id, label, value, files, folder, placeholder, match, family, onChange }: {
  id: string;
  label: string;
  value: string;
  files: string[];
  folder: string | undefined;
  placeholder?: string;
  /** Names of the files made for this form, when the folder holds other kinds too: those are listed apart from the rest. */
  match?: string[];
  /** The model family the form is for: a file whose weights say they are its is "made for this" whatever its name. */
  family?: string;
  onChange(value: string): void;
}) {
  const known = useModelInfo(folder);
  const info = known.data?.items;
  const updates = useModelUpdates();
  const newerOf = (f: string) => updates.data?.items.find((u) => u.folder === folder && u.file === f && u.newer)?.newer ?? null;
  const options = useMemo(() => {
    const made = match?.map((p) => new RegExp(p, "i"));
    // the files arrive with the ones made for it first; a file that says it is another model's is told apart too
    const groupOf = (f: string) => {
      if (!made) return undefined;
      const base = info?.[f]?.base;
      if (made.some((re) => re.test(f)) || (family && sameBase(base, family))) return "Made for this";
      if (base && family && !sameBase(base, family)) return `Made for other models (${base})`;
      return `Everything else in models/${folder}`;
    };
    return files.map((f) => {
      const o = fileOption(f, info?.[f]);
      const newer = newerOf(f);
      return { ...o, ...(newer ? { note: [o.note, `newer on Civitai: ${newer.name}`].filter(Boolean).join(" · ") } : {}), ...(made ? { group: groupOf(f) } : {}) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, info, match, folder, family, updates.data]);
  return <Select id={id} label={label} value={value} onChange={onChange} options={options} placeholder={placeholder} searchHint={info && files.length > 1 ? `Search ${files.length} by name or model` : undefined} />;
}

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A field's name, with its explanation (a line, or a ? on hover) and, apart from that, what must always be seen beside it ("0 of 6", "set by the start image"). */
function Label({ htmlFor, children, note, aside }: { htmlFor?: string; children: string; note?: string; aside?: string }) {
  const explain = useExplain((s) => s.on);
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex min-w-0 items-center gap-1.5">
        <label htmlFor={htmlFor} className="shrink-0 text-xs font-semibold">{children}</label>
        {note && !explain && <Help text={note} />}
      </span>
      {(aside || (note && explain)) && <span className="min-w-0 text-right text-xs text-ink-2">{aside ?? note}</span>}
    </div>
  );
}

/** Proportions to choose from beyond the ones a recipe names, tallest to widest. */
const RATIOS: Array<{ label: string; w: number; h: number }> = [
  { label: "Portrait 9:16", w: 9, h: 16 }, { label: "Portrait 2:3", w: 2, h: 3 }, { label: "Portrait 3:4", w: 3, h: 4 }, { label: "Portrait 4:5", w: 4, h: 5 },
  { label: "Square 1:1", w: 1, h: 1 },
  { label: "Landscape 5:4", w: 5, h: 4 }, { label: "Landscape 4:3", w: 4, h: 3 }, { label: "Landscape 3:2", w: 3, h: 2 }, { label: "Widescreen 16:9", w: 16, h: 9 }, { label: "Ultrawide 21:9", w: 21, h: 9 },
];

/**
 * The shape and size of what is made: the recipe's own shapes as buttons, any other proportion from a
 * list (at the same number of pixels, so the amount of detail and the time stay about the same), and the
 * width and height themselves, typed. A recipe that only takes the proportions gets no pixels to type.
 */
function SizeField({ spec, value: size, values, onChange }: { spec: Extract<InputSpec, { type: "size" }>; value: SizeValue; values?: Record<string, unknown>; onChange(value: SizeValue): void }) {
  const shape = spec.shapes.find((s) => s.width === size.width && s.height === size.height);
  // a recipe that takes the proportions alone: the frame that comes out is the short side asked for, in these proportions
  const short = spec.ratioOnly && spec.short ? Number(values?.[spec.short]) : NaN;
  const frameOfShape = (s: { width: number; height: number }) => (Number.isFinite(short) && short > 0 ? frameOf(s, short, { grid: spec.grid, maxPixels: spec.maxPixels ?? Infinity }) : null);
  const comesOut = frameOfShape(size);
  // a pass that enlarges it afterwards: the frame it ends at
  const r32 = (n: number) => Math.max(64, Math.round(n / 32) * 32);
  const scaled = comesOut && spec.scaledBy && values?.[spec.scaledBy.on] && values[spec.scaledBy.on] !== "Off" ? { width: r32(comesOut.width * Number(values[spec.scaledBy.by] ?? 2)), height: r32(comesOut.height * Number(values[spec.scaledBy.by] ?? 2)) } : null;
  // what decides the shape instead, when something is there: a start image, a clip joined
  const decidedBy = (spec.decidedBy ?? []).find((id) => { const v = values?.[id]; return Array.isArray(v) ? v.length > 0 : Boolean(v); });
  const deciderLabel = decidedBy ? (/previous|next|clip/i.test(decidedBy) ? "the clip it joins" : "the start image") : null;
  const snap = (n: number) => Math.min(spec.max, Math.max(spec.min, Math.round(n / spec.grid) * spec.grid));
  // the pixels to keep when the proportions change: those of the size now, or of the recipe's own shape before one is set
  const first = spec.shapes.find((s) => s.id === spec.default) ?? spec.shapes[0]!;
  const area = size.width && size.height ? size.width * size.height : first.width * first.height;
  const sized = (r: { w: number; h: number }) => {
    const height = Math.sqrt((area * r.h) / r.w);
    return { width: snap((height * r.w) / r.h), height: snap(height) };
  };
  const others = RATIOS.map((r) => ({ ...r, ...sized(r) })).filter((r) => !spec.shapes.some((s) => s.width === r.width && s.height === r.height));
  const picked = others.find((r) => r.width === size.width && r.height === size.height);
  const said = (w: number, h: number) => `${w} × ${h} · ${megapixels(w, h)}`;
  return (
    <div className={cx("flex flex-col gap-1.5", deciderLabel && "opacity-60")} title={deciderLabel ? `${deciderLabel[0]!.toUpperCase()}${deciderLabel.slice(1)} decides the shape: this does nothing now.` : undefined}>
      <Label note={spec.note} aside={deciderLabel ? `set by ${deciderLabel}${spec.ratioOnly ? ": only the resolution counts" : ""}` : spec.ratioOnly ? undefined : said(size.width, size.height)}>{spec.label}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label={spec.label} value={shape?.id ?? ""} options={spec.shapes.map((s) => ({ value: s.id, label: s.label }))} onChange={(shapeId) => {
          const s = spec.shapes.find((x) => x.id === shapeId)!;
          onChange({ width: s.width, height: s.height });
        }} />
        <div className="min-w-40 grow">
          <Select
            size="sm"
            label="More shapes"
            placeholder="More shapes…"
            searchHint="a proportion, 16:9, portrait…"
            value={picked ? picked.label : ""}
            onChange={(label) => {
              const r = others.find((x) => x.label === label);
              if (r) onChange({ width: r.width, height: r.height });
            }}
            options={others.map((r) => {
              const f = spec.ratioOnly ? frameOfShape(r) : r;
              return { value: r.label, label: r.label, note: f ? `${f.width} × ${f.height}` : undefined };
            })}
          />
        </div>
      </div>
      {comesOut && !deciderLabel && (
        <span className="text-xs text-ink-2">
          Comes out as <span className="font-mono text-ink">{said(comesOut.width, comesOut.height)}</span>{comesOut.width !== Math.round(short) && comesOut.height !== Math.round(short) ? " (held within what the model takes)" : ""}
          {scaled && <>, upscaled to <span className="font-mono text-ink">{said(scaled.width, scaled.height)}</span></>}
        </span>
      )}
      {!spec.ratioOnly && (
        <div className="flex items-center gap-2 text-ink-2">
          <NumberBox label="Width, in pixels" value={size.width} min={spec.min} max={spec.max} step={spec.grid} unit="px" onCommit={(width) => onChange({ width: snap(width), height: size.height })} />
          <button type="button" aria-label="Swap width and height" title="Swap width and height" onClick={() => onChange({ width: size.height, height: size.width })} className="flex h-8 w-8 items-center justify-center rounded-md border border-line-strong hover:bg-hover">
            <ArrowLeftRight size={14} />
          </button>
          <NumberBox label="Height, in pixels" value={size.height} min={spec.min} max={spec.max} step={spec.grid} unit="px" onCommit={(height) => onChange({ width: size.width, height: snap(height) })} />
          <span className="text-xs">width × height</span>
        </div>
      )}
    </div>
  );
}

/** The form's main text, for a field that puts words into it or takes them out (a LoRA's trigger words). */
interface MainText {
  text: string;
  style: "tags" | "sentences";
  set(text: string): void;
}

export function Field({ spec, value, values, options, family, model, onChange, onValue, main }: {
  spec: InputSpec;
  value: unknown;
  /** The whole form, for a field that goes with another one (the part painted over a picture). */
  values?: Record<string, unknown>;
  /** What this ComfyUI offers for a model, LoRA or ComfyUI-backed choice input. */
  options: string[] | undefined;
  /** The model family the form is for: LoRAs made for it are listed first. */
  family?: FamilyInfo;
  /** The model file in use: LoRAs made for that very model, or its line, come before the rest of the family's. */
  model?: string;
  onChange(value: unknown): void;
  /** Set another input of the form (the part of a sound that is used is two numbers of their own). */
  onValue?(input: string, value: unknown): void;
  main?: MainText;
}) {
  const id = useId();
  const explain = useExplain((st) => st.on);
  switch (spec.type) {
    case "prompt":
      return <PromptField spec={spec} id={id} value={String(value ?? "")} values={values} onChange={onChange} />;

    case "model":
      return (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id} note={spec.note} aside={options?.length ? `${options.length} on your ComfyUI` : undefined}>{spec.label}</Label>
          <FileSelect id={id} label={spec.label} value={String(value ?? "")} onChange={onChange} files={options ?? []} folder={spec.folder} match={spec.match} family={family?.name} placeholder={options?.length ? "Choose a model" : `Nothing found in models/${spec.folder}`} />
        </div>
      );

    case "loras":
      return <Loras spec={spec} value={(value as LoraValue[] | undefined) ?? []} options={options ?? []} family={family} model={model} onChange={onChange} main={main} />;

    case "size":
      return <SizeField spec={spec} value={(value as SizeValue | undefined) ?? { width: 0, height: 0 }} values={values} onChange={onChange} />;

    case "number": {
      const n = Number(value ?? spec.default);
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5"><label htmlFor={id}>{spec.label}</label>{spec.note && !explain && <Help text={spec.note} />}</span>
            <NumberBox label={`${spec.label}, typed`} value={n} min={spec.min} max={spec.max} step={spec.step} unit={spec.unit} onCommit={onChange} />
          </div>
          <input id={id} type="range" min={spec.min} max={spec.max} step={spec.step} value={n} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
          {spec.picks && (
            <div className="flex flex-wrap gap-1">
              {spec.picks.map((p) => (
                <button key={p} type="button" onClick={() => onChange(p)} className={cx("rounded-md border px-2 py-0.5 font-mono text-xs", p === n ? "border-accent text-accent" : "border-line text-ink-2 hover:bg-hover hover:text-ink")}>
                  {p}{spec.unit?.trim() ?? ""}
                </button>
              ))}
            </div>
          )}
          {explain && <Note text={spec.note} />}
        </div>
      );
    }

    case "toggle":
      if (spec.captions) {
        return (
          <div className="flex flex-col gap-1.5">
            <Label note={spec.note}>{spec.label}</Label>
            <Segmented
              label={spec.label}
              value={value ? "on" : "off"}
              options={[{ value: "on", label: spec.captions.on }, { value: "off", label: spec.captions.off }]}
              onChange={(v) => onChange(v === "on")}
            />
          </div>
        );
      }
      return <Toggle on={Boolean(value)} onChange={onChange} label={spec.label} note={spec.note} />;

    case "choice": {
      // when ComfyUI offers nothing for it (not asked yet, or it lists no file), what is set is still shown
      const all = Array.isArray(spec.options) ? [...(spec.extra ?? []), ...spec.options] : options?.length ? options : [spec.default];
      const current = String(value ?? pickChoice(spec, options));
      // a few short choices sit side by side; file names and long lists go in a list
      const few = all.length <= 4 && all.every((o) => fileLabel(o).length <= 14);
      return (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id} note={spec.note}>{spec.label}</Label>
          {few ? (
            <Segmented label={spec.label} value={current} options={all.map((o) => ({ value: o, label: fileLabel(o) }))} onChange={onChange} />
          ) : (
            <FileSelect id={id} label={spec.label} value={current} onChange={onChange} files={all.includes(current) ? all : [current, ...all]} folder={Array.isArray(spec.options) ? undefined : FOLDER_OF[spec.options.input]} />
          )}
        </div>
      );
    }

    case "seed":
      return <SeedField id={id} label={spec.label} value={Number(value ?? RANDOM_SEED)} onChange={onChange} />;

    case "image":
      if (spec.role === "mask") {
        const picture = spec.of ? values?.[spec.of] : undefined;
        return <MaskField label={spec.label} note={spec.note} picture={typeof picture === "string" ? picture : null} value={typeof value === "string" ? value : null} onChange={onChange} />;
      }
      return <PictureField label={spec.label} optional={Boolean(spec.optional)} value={typeof value === "string" ? value : null} onChange={onChange} />;

    case "references":
      return <ReferencesField label={spec.label} note={spec.note} max={spec.max} roles={spec.roles} video={spec.media === "video"} value={(value as ReferenceValue[] | undefined) ?? []} onChange={onChange} />;

    case "audio":
      return (
        <SoundField
          label={spec.label} note={spec.note} optional={Boolean(spec.optional)} value={typeof value === "string" ? value : null} onChange={onChange}
          part={spec.window && onValue ? {
            start: Number(values?.[spec.window.start] ?? 0), seconds: Number(values?.[spec.window.seconds] ?? 8),
            onStart: (v) => onValue(spec.window!.start, v), onSeconds: (v) => onValue(spec.window!.seconds, v),
          } : undefined}
        />
      );

    case "clip":
      return <ClipField label={spec.label} note={spec.note} role={spec.role} optional={Boolean(spec.optional)} value={(value as ClipValue | undefined) ?? null} onChange={onChange} />;
  }
}

/**
 * Under a LoRA's name: the model it is for and the words that call it up. "+" puts the words in the
 * prompt and "−" takes them out again; a click on them copies them; the pencil replaces them by the
 * user's own.
 */
function LoraWords({ file, info, more, main }: { file: string; info: ModelInfo | undefined; more: ModelWords | undefined; main?: MainText }) {
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [typing, setTyping] = useState<string | null>(null);
  const { words, from } = wordsOf(info, more);
  const save = useMutation({
    mutationFn: (own: string) => api.setModelWords("loras", file, own.trim() || null),
    onSuccess: (r) => client.setQueryData<{ items: Record<string, ModelWords> }>(["model-words", "loras"], (old) => ({ items: { ...(old?.items ?? {}), ...r.items } })),
  });
  const small = "flex h-5 shrink-0 items-center gap-1 rounded px-1 text-[11px] text-ink-2 enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-35";
  // which of them the prompt holds already: "+" has nothing to add when all are there, "−" nothing to take when none is
  const there = main && words ? wordsIn(main.text, words, main.style) : { any: false, all: false };
  if (typing !== null) {
    return (
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(typing);
          setTyping(null);
        }}
      >
        <input
          autoFocus
          aria-label={`Your trigger words for ${fileLabel(file)}`}
          placeholder="Your words for it (empty: back to its own)"
          value={typing}
          maxLength={600}
          onChange={(e) => setTyping(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setTyping(null)}
          className="h-7 min-w-0 grow rounded-md border border-line bg-ground px-2 text-xs placeholder:text-ink-3"
        />
        <button type="submit" aria-label="Keep these words" className={small}><Check size={12} /></button>
      </form>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-1 text-xs text-ink-2">
      {info?.base && <span className="shrink-0 rounded bg-hover px-1.5 py-px text-[10px] font-semibold text-ink-2">{info.base}</span>}
      <button
        type="button"
        disabled={!words}
        title={words && from ? `${FROM[from]}: ${words}\nClick to copy them.` : undefined}
        onClick={() => void navigator.clipboard.writeText(words).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
        className="flex min-w-0 grow items-center gap-1.5 text-left enabled:hover:text-ink"
      >
        <span className={cx("min-w-0 truncate", !words && "text-ink-3", there.all && "text-ink")}>{copied ? "Copied" : words || "No trigger words known"}</span>
        {words && !copied && <Copy size={11} className="shrink-0" />}
      </button>
      {main && words && from !== "training" && (
        <span className="flex shrink-0 items-center rounded border border-line">
          <button type="button" disabled={there.all} aria-label={`Put the trigger words of ${fileLabel(file)} in the prompt`} title={there.all ? "They are in the prompt" : "Put these words in the prompt"} onClick={() => main.set(appendTo(main.text, words, main.style))} className={small}><Plus size={12} /></button>
          <button type="button" disabled={!there.any} aria-label={`Take the trigger words of ${fileLabel(file)} out of the prompt`} title={there.any ? "Take these words out of the prompt" : "They are not in the prompt"} onClick={() => main.set(removeFrom(main.text, words, main.style))} className={small}><Minus size={12} /></button>
        </span>
      )}
      <button type="button" aria-label={`Your own trigger words for ${fileLabel(file)}`} title="Write your own words for this LoRA: they replace the ones shown" onClick={() => setTyping(more?.own ?? "")} className={small}><Pencil size={11} /></button>
    </div>
  );
}

/** Files whose words were asked of Civitai while this page is open: each is asked once. */
const askedWords = new Set<string>();

/**
 * The words that call LoRAs up, for the ones in use: what each file says, what is kept beside it, and,
 * for a file that gives none, what its page on Civitai gives. That page is asked by the file's
 * fingerprint, once (the server asks nothing unless looking things up is on in Settings).
 */
/**
 * Random, or a seed typed in that is kept the same, moved one up or one down after every render; the way it moves
 * is one setting for every form (ComfyUI's "control after generate"). "Make 4" with +1 takes four seeds in a row.
 */
function SeedField({ id, label, value, onChange }: { id: string; label: string; value: number; onChange(v: number): void }) {
  const mode = useSeedMode((s) => s.mode);
  const setMode = useSeedMode((s) => s.set);
  const random = value === RANDOM_SEED;
  const pick = (v: "random" | SeedMode) => {
    if (v === "random") return onChange(RANDOM_SEED);
    setMode(v);
    if (random) onChange(0);
  };
  // two lines: the label with the four chips, then the seed itself (four chips beside a number box fold into a block in a narrow panel)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <label htmlFor={id} className="shrink-0">{label}</label>
        <Segmented
          label="Seed"
          value={random ? "random" : mode}
          options={[{ value: "random", label: "Random" }, { value: "fixed", label: "Fixed" }, { value: "up", label: "+1" }, { value: "down", label: "−1" }]}
          onChange={pick}
        />
      </div>
      {!random && (
        <input
          id={id}
          type="number"
          min={0}
          max={4294967295}
          value={value}
          title={mode === "fixed" ? "This seed, every render" : mode === "up" ? "This seed, then one up after each render (a batch takes them in a row)" : "This seed, then one down after each render (a batch takes them in a row)"}
          onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
          className={cx(field, "h-9 w-full font-mono")}
        />
      )}
    </div>
  );
}

export function useLoraWordsOf(files: string[]) {
  const known = useModelInfo("loras");
  const info = known.data?.items ?? {};
  const extra = useModelWords("loras");
  const more = extra.data?.items ?? {};
  const client = useQueryClient();
  const silent = files.filter((f) => info[f] && !info[f]!.trigger && !more[nameOf(f)] && !askedWords.has(f));
  const silentKey = silent.join("|");
  useEffect(() => {
    if (!silentKey || !extra.isSuccess) return;
    const asked = silentKey.split("|");
    for (const f of asked) askedWords.add(f);
    api.findModelWords("loras", asked).then(
      (r) => {
        client.setQueryData<{ items: Record<string, ModelWords> }>(["model-words", "loras"], (old) => ({ items: { ...(old?.items ?? {}), ...r.items } }));
        // a page came with the words
        void client.invalidateQueries({ queryKey: ["model-pages", "loras"] });
      },
      () => {},
    );
  }, [silentKey, extra.isSuccess, client]);
  return { known, extra, info, more, of: (file: string) => wordsOf(info[file], more[nameOf(file)]) };
}

function Loras({ spec, value, options, family, model, onChange, main }: {
  spec: Extract<InputSpec, { type: "loras" }>;
  value: LoraValue[];
  options: string[];
  family: FamilyInfo | undefined;
  model: string | undefined;
  onChange(value: LoraValue[]): void;
  main?: MainText;
}) {
  // what each file says about itself (read once by the server, arriving in the background the first time), and the words kept beside it
  const { known, extra, info, more } = useLoraWordsOf(value.map((v) => v.file));
  const free = options.filter((o) => !value.some((v) => v.file === o));
  const set = (i: number, weight: number) => onChange(value.map((v, j) => (j === i ? { ...v, weight } : v)));
  const choices = useMemo(() => {
    const made = free.map((file, index) => ({ file, index, about: info[file], fit: family ? loraFit(family, file, info[file]) : 0, near: model ? modelFit(model, file, info[file]) : 0 }));
    // sections only when the files tell enough to make them: otherwise the list stays as ComfyUI gives it
    const sorted = made.some((m) => m.fit > 0 || m.near > 0);
    const wanted = family ? baseGroup(baseLabel(family.name)) : "";
    // a list for one half of a model pair ("High", "Low") puts the files of that half first
    // (as a word of its own in the file's name or folder: "Low_noise", "LowNoise", "Wan/Low", not "blow")
    const half = /\bhigh\b/i.test(spec.label) ? /(^|[^A-Za-z])(high|High|HIGH)(?![a-z])/ : /\blow\b/i.test(spec.label) ? /(^|[^A-Za-z])(low|Low|LOW)(?![a-z])/ : null;
    // made for the very model in use (or its line) first; then the rest of its family; a LoRA of another line of the family after those
    const line = model ? lineOf(model) : null;
    const rank = (m: { fit: number; near: number }) => (m.near > 0 && m.fit >= 0 ? 0 : m.fit > 0 ? (m.near < 0 ? 2 : 1) : m.fit === 0 ? 3 : 4);
    const titles = [
      line ? `Made for ${line}` : "Made for the model in use", `Made for ${wanted || "this model"}`,
      `Made for another kind of ${wanted || "model"}`, "Do not say which model they are for", "Made for other models",
    ];
    if (sorted) made.sort((a, b) => rank(a) - rank(b) || (half ? Number(half.test(b.file)) - Number(half.test(a.file)) : 0) || b.near - a.near || b.fit - a.fit || a.index - b.index);
    return made.map((m): Option => ({
      ...fileOption(m.file, m.about),
      detail: wordsOf(m.about, more[nameOf(m.file)]).words || undefined,
      ...(more[nameOf(m.file)] ? { search: [fileOption(m.file, m.about).search, more[nameOf(m.file)]!.own, more[nameOf(m.file)]!.found].filter(Boolean).join(" ") } : {}),
      ...(sorted ? { group: titles[rank(m)] } : {}),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [free.join("|"), known.data, extra.data, family?.id, spec.label, model]);
  return (
    <div className="flex flex-col gap-1.5">
      <Label aside={`${value.length} of ${spec.max}`}>{spec.label}</Label>
      {value.map((l, i) => (
        <div key={l.file} className="flex flex-col gap-1 rounded-lg border border-line bg-raised py-1.5 pr-1 pl-3">
          <div className="flex items-center gap-2">
            <ModelLink folder="loras" file={l.file} className="min-w-0 grow font-semibold" />
            <input type="range" aria-label={`Strength of ${fileLabel(l.file)}`} min={-1} max={2} step={0.05} value={Math.max(-1, Math.min(2, l.weight))} onChange={(e) => set(i, Number(e.target.value))} className="w-24 shrink-0" />
            <NumberBox label={`Strength of ${fileLabel(l.file)}, typed`} value={l.weight} min={-4} max={4} step={0.05} onCommit={(v) => set(i, v)} className="shrink-0 text-xs" />
            <button type="button" aria-label={`Remove ${fileLabel(l.file)}`} onClick={() => onChange(value.filter((_, j) => j !== i))} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover">
              <X size={14} />
            </button>
          </div>
          <LoraWords file={l.file} info={info[l.file]} more={more[nameOf(l.file)]} main={main} />
        </div>
      ))}
      {value.length < spec.max && (
        <Select
          dashed
          size="sm"
          className="h-9"
          icon={<Plus size={14} className="shrink-0" />}
          label={`${spec.label}, add one`}
          placeholder={options.length ? "Add a LoRA" : "No LoRAs found on your ComfyUI"}
          searchHint={`Search ${free.length} by name, trigger words or model${known.data?.pending ? ` (still reading ${known.data.pending} files)` : ""}`}
          value=""
          options={choices}
          onChange={(file) => onChange([...value, { file, weight: 0.8 }])}
        />
      )}
    </div>
  );
}
