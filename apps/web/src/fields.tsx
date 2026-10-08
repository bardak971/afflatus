import { useId } from "react";
import { pickChoice, RANDOM_SEED, type ClipValue, type InputSpec, type LoraValue, type ReferenceValue, type SizeValue } from "@afflatus/core";
import type { FamilyInfo } from "./api";
import { useCastPictures } from "./castPictures";
import { FileSelect, FOLDER_OF } from "./fields/FileSelect";
import { Label } from "./fields/Label";
import { Loras, type MainText } from "./fields/Loras";
import { PromptField } from "./fields/PromptField";
import { SeedField } from "./fields/SeedField";
import { SizeField } from "./fields/SizeField";
import { fileLabel } from "./format";
import { MaskField } from "./MaskField";
import { ClipField, PictureField, ReferencesField, SoundField } from "./PictureField";
import { useExplain } from "./store";
import { cx, NumberBox, Segmented, Toggle, Help, Note } from "./ui";

export { useLoraWordsOf } from "./fields/Loras";

/**
 * One control per input type. This file is the only place that knows how an input is drawn: a recipe
 * only says which inputs it has, so a new recipe needs nothing here. The fields of their own (a prompt,
 * a size, LoRAs, a seed, a file) are in fields/.
 */

/** The value an input starts with, given what this ComfyUI offers for it. */
export function defaultOf(spec: InputSpec, options: string[] | undefined): unknown {
  switch (spec.type) {
    // an example is shown, not filled in
    case "prompt": return spec.example ? "" : spec.default ?? "";
    case "model": return spec.default ?? options?.[0] ?? "";
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

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
  // the pictures the form's cast adds to this reference input when it is sent
  const cast = useCastPictures(spec.id);
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
      const raw = String(value ?? pickChoice(spec, options));
      // a value an older form saved shows as the option that replaced it
      const current = spec.renamed?.[raw] ?? raw;
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
      return <ReferencesField label={spec.label} note={spec.note} max={spec.max} roles={spec.roles} video={spec.media === "video"} value={(value as ReferenceValue[] | undefined) ?? []} onChange={onChange} cast={cast} />;

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
