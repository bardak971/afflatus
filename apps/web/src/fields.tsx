import { useId, useMemo, useState } from "react";
import { ArrowLeftRight, Copy, Plus, X } from "lucide-react";
import { baseGroup, baseLabel, lineOf, loraFit, modelFit, pickChoice, type ClipValue, type InputSpec, type LoraValue, type ReferenceValue, type SizeValue } from "@studai/core";
import type { FamilyInfo, ModelInfo } from "./api";
import { useModelInfo } from "./data";
import { fileLabel } from "./format";
import { MaskField } from "./MaskField";
import { ClipField, PictureField, ReferencesField, SoundField } from "./PictureField";
import { Select, type Option } from "./Select";
import { AutoText, cx, NumberBox, Segmented, Toggle } from "./ui";
import { ModelLink } from "./ModelLink";

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

/** The words that call a LoRA up: what its author wrote, or else the words it was trained with most. */
const wordsOf = (info: ModelInfo | undefined) => info?.trigger ?? info?.tags?.slice(0, 8).join(", ") ?? "";

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
function FileSelect({ id, label, value, files, folder, placeholder, match, onChange }: {
  id: string;
  label: string;
  value: string;
  files: string[];
  folder: string | undefined;
  placeholder?: string;
  /** Names of the files made for this form, when the folder holds other kinds too: those are listed apart from the rest. */
  match?: string[];
  onChange(value: string): void;
}) {
  const known = useModelInfo(folder);
  const info = known.data?.items;
  const options = useMemo(() => {
    const made = match?.map((p) => new RegExp(p, "i"));
    // the files arrive with the ones made for it first
    return files.map((f) => ({ ...fileOption(f, info?.[f]), ...(made ? { group: made.some((re) => re.test(f)) ? "Made for this" : `Everything else in models/${folder}` } : {}) }));
  }, [files, info, match, folder]);
  return <Select id={id} label={label} value={value} onChange={onChange} options={options} placeholder={placeholder} searchHint={info && files.length > 1 ? `Search ${files.length} by name or model` : undefined} />;
}

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function Label({ htmlFor, children, note }: { htmlFor?: string; children: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-xs font-semibold">{children}</label>
      {note && <span className="text-xs text-ink-2">{note}</span>}
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
function SizeField({ spec, value: size, onChange }: { spec: Extract<InputSpec, { type: "size" }>; value: SizeValue; onChange(value: SizeValue): void }) {
  const shape = spec.shapes.find((s) => s.width === size.width && s.height === size.height);
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
  const megapixels = (size.width * size.height) / 1e6;
  return (
    <div className="flex flex-col gap-1.5">
      <Label note={spec.note ?? (spec.ratioOnly ? undefined : `${megapixels.toFixed(megapixels < 10 ? 1 : 0)} megapixels`)}>{spec.label}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label={spec.label} value={shape?.id ?? ""} options={spec.shapes.map((s) => ({ value: s.id, label: s.label }))} onChange={(shapeId) => {
          const s = spec.shapes.find((x) => x.id === shapeId)!;
          onChange({ width: s.width, height: s.height });
        }} />
        <div className="min-w-40 grow">
          <Select
            size="sm"
            label="Aspect ratio"
            placeholder="Aspect ratio"
            value={picked ? picked.label : ""}
            onChange={(label) => {
              const r = others.find((x) => x.label === label);
              if (r) onChange({ width: r.width, height: r.height });
            }}
            options={others.map((r) => ({ value: r.label, label: r.label, note: spec.ratioOnly ? undefined : `${r.width} × ${r.height}` }))}
          />
        </div>
      </div>
      {!spec.ratioOnly && (
        <div className="flex items-center gap-2 text-ink-2">
          <NumberBox label="Width, in pixels" value={size.width} min={spec.min} max={spec.max} step={spec.grid} unit="px" onCommit={(width) => onChange({ width: snap(width), height: size.height })} />
          <button type="button" aria-label="Swap width and height" title="Swap width and height" onClick={() => onChange({ width: size.height, height: size.width })} className="flex h-8 w-8 items-center justify-center rounded-md border border-line-strong hover:bg-hover">
            <ArrowLeftRight size={14} />
          </button>
          <NumberBox label="Height, in pixels" value={size.height} min={spec.min} max={spec.max} step={spec.grid} unit="px" onCommit={(height) => onChange({ width: size.width, height: snap(height) })} />
          <span className="text-xs">wide × high</span>
        </div>
      )}
    </div>
  );
}

export function Field({ spec, value, values, options, family, model, onChange }: {
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
}) {
  const id = useId();
  switch (spec.type) {
    case "prompt":
      return (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id} note={spec.note}>{spec.label}</Label>
          <AutoText
            id={id}
            rows={spec.optional && !spec.example ? 2 : 4}
            value={String(value ?? "")}
            placeholder={spec.placeholder}
            onChange={(e) => onChange(e.target.value)}
            className={cx(field, "py-2.5 leading-normal", spec.optional && !spec.example ? "text-[13px]" : "text-sm")}
          />
        </div>
      );

    case "model":
      return (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id} note={spec.note ?? (options?.length ? `${options.length} on your ComfyUI` : undefined)}>{spec.label}</Label>
          <FileSelect id={id} label={spec.label} value={String(value ?? "")} onChange={onChange} files={options ?? []} folder={spec.folder} match={spec.match} placeholder={options?.length ? "Choose a model" : `Nothing found in models/${spec.folder}`} />
        </div>
      );

    case "loras":
      return <Loras spec={spec} value={(value as LoraValue[] | undefined) ?? []} options={options ?? []} family={family} model={model} onChange={onChange} />;

    case "size":
      return <SizeField spec={spec} value={(value as SizeValue | undefined) ?? { width: 0, height: 0 }} onChange={onChange} />;

    case "number": {
      const n = Number(value ?? spec.default);
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={id}>{spec.label}</label>
            <NumberBox label={`${spec.label}, typed`} value={n} min={spec.min} max={spec.max} step={spec.step} unit={spec.unit} onCommit={onChange} />
          </div>
          <input id={id} type="range" min={spec.min} max={spec.max} step={spec.step} value={n} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
          {spec.note && <span className="text-xs text-ink-2">{spec.note}</span>}
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

    case "seed": {
      const seed = Number(value ?? RANDOM_SEED);
      const random = seed === RANDOM_SEED;
      return (
        <div className="flex items-center gap-3">
          <label htmlFor={id} className="shrink-0">{spec.label}</label>
          <Segmented
            label="Seed"
            value={random ? "random" : "fixed"}
            options={[{ value: "random", label: "Random" }, { value: "fixed", label: "Fixed" }]}
            onChange={(v) => onChange(v === "random" ? RANDOM_SEED : 0)}
          />
          {!random && (
            <input
              id={id}
              type="number"
              min={0}
              max={4294967295}
              value={seed}
              onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              className={cx(field, "h-9 min-w-0 grow font-mono")}
            />
          )}
        </div>
      );
    }

    case "image":
      if (spec.role === "mask") {
        const picture = spec.of ? values?.[spec.of] : undefined;
        return <MaskField label={spec.label} note={spec.note} picture={typeof picture === "string" ? picture : null} value={typeof value === "string" ? value : null} onChange={onChange} />;
      }
      return <PictureField label={spec.label} optional={Boolean(spec.optional)} value={typeof value === "string" ? value : null} onChange={onChange} />;

    case "references":
      return <ReferencesField label={spec.label} note={spec.note} max={spec.max} roles={spec.roles} video={spec.media === "video"} value={(value as ReferenceValue[] | undefined) ?? []} onChange={onChange} />;

    case "audio":
      return <SoundField label={spec.label} note={spec.note} optional={Boolean(spec.optional)} value={typeof value === "string" ? value : null} onChange={onChange} />;

    case "clip":
      return <ClipField label={spec.label} note={spec.note} role={spec.role} optional={Boolean(spec.optional)} value={(value as ClipValue | undefined) ?? null} onChange={onChange} />;
  }
}

/** What a LoRA's file says about it, under its name: the model it is for and the words that call it up. Click to copy the words. */
function LoraWords({ info }: { info: ModelInfo | undefined }) {
  const [copied, setCopied] = useState(false);
  const words = wordsOf(info);
  if (!info?.base && !words) return null;
  return (
    <button
      type="button"
      disabled={!words}
      title={words ? `${info?.trigger ? "Its trigger words" : "The words it was trained with most"}: ${words}\nClick to copy them.` : undefined}
      onClick={() => void navigator.clipboard.writeText(words).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
      className="flex min-w-0 items-center gap-1.5 text-left text-xs text-ink-2 enabled:hover:text-ink"
    >
      {info?.base && <span className="shrink-0 rounded bg-hover px-1.5 py-px text-[10px] font-semibold text-ink-2">{info.base}</span>}
      <span className="min-w-0 truncate">{copied ? "Copied" : words}</span>
      {words && !copied && <Copy size={11} className="shrink-0" />}
    </button>
  );
}

function Loras({ spec, value, options, family, model, onChange }: {
  spec: Extract<InputSpec, { type: "loras" }>;
  value: LoraValue[];
  options: string[];
  family: FamilyInfo | undefined;
  model: string | undefined;
  onChange(value: LoraValue[]): void;
}) {
  // what each file says about itself: read once by the server, arriving in the background the first time
  const known = useModelInfo("loras");
  const info = known.data?.items ?? {};
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
      detail: wordsOf(m.about) || undefined,
      ...(sorted ? { group: titles[rank(m)] } : {}),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [free.join("|"), known.data, family?.id, spec.label, model]);
  return (
    <div className="flex flex-col gap-1.5">
      <Label note={`${value.length} of ${spec.max}`}>{spec.label}</Label>
      {value.map((l, i) => (
        <div key={l.file} className="flex flex-col gap-1 rounded-lg border border-line bg-raised py-1.5 pr-1 pl-3">
          <div className="flex items-center gap-2">
            <ModelLink folder="loras" file={l.file} className="min-w-0 grow font-semibold" />
            <input type="range" aria-label={`Strength of ${fileLabel(l.file)}`} min={0} max={1.5} step={0.05} value={l.weight} onChange={(e) => set(i, Number(e.target.value))} className="w-24 shrink-0" />
            <span className="w-9 shrink-0 text-right font-mono text-xs">{l.weight.toFixed(2)}</span>
            <button type="button" aria-label={`Remove ${fileLabel(l.file)}`} onClick={() => onChange(value.filter((_, j) => j !== i))} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover">
              <X size={14} />
            </button>
          </div>
          <LoraWords info={info[l.file]} />
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
