import { useId } from "react";
import { pickChoice, RANDOM_SEED, partFit, secondsOf, type PartFit, type ClipValue, type CueValue, type InputSpec, type LoraValue, type ReferenceValue, type SizeValue } from "@afflatus/core";
import type { FamilyInfo } from "./api";
import { useCastPictures, useCastVoice } from "./castPictures";
import { FileSelect, FOLDER_OF, ModelField } from "./fields/FileSelect";
import { Loras, type MainText } from "./fields/Loras";
import { PromptField } from "./fields/PromptField";
import { SeedField } from "./fields/SeedField";
import { SizeField } from "./fields/SizeField";
import { FieldRow } from "./fields/FieldRow";
import { withNote } from "./fieldNotes";
import { fileLabel } from "./format";
import { MaskField } from "./MaskField";
import { MakeFromDriving } from "./motionPicture";
import { Slider } from "./Slider";
import { ClipField, CuesField, PictureField, ReferencesField, SoundField, type PartProps } from "./PictureField";
import { cx, Segmented, Toggle } from "./ui";

export { useLoraWordsOf } from "./fields/Loras";

/**
 * One control per input type. This file is the only place that knows how an input is drawn: a recipe
 * only says which inputs it has, so a new recipe needs nothing here. The fields of their own (a prompt,
 * a size, LoRAs, a seed, a file) are in fields/.
 */

// where an input's value starts, and when two values are the same: in form.ts, which works with them without drawing a
// field (imported from here, form.ts would load every field, and through them the viewer, with the app)
export { sameValue } from "./form";
// the row is a file of its own: the dialogs that use it alone (a new project) do not take every field with it
export { FieldRow } from "./fields/FieldRow";

/**
 * The part of a sound or a source video that is used, as its field shows it: the two number inputs that say it, within its
 * length input's own limits (every field keeps to its recipe's), and what one clip holds of it when the recipe says.
 */
function partProps(w: { start: string; seconds: string; fits?: PartFit } | undefined, specs: InputSpec[] | undefined, values: Record<string, unknown> | undefined, onValue: ((input: string, value: unknown) => void) | undefined): PartProps | undefined {
  if (!w || !onValue) return undefined;
  const length = specs?.find((s) => s.id === w.seconds);
  const limits = length?.type === "number" ? { min: length.min ?? 1, max: length.max ?? 15, usual: Number(length.default ?? 8) } : { min: 1, max: 15, usual: 8 };
  return {
    start: Number(values?.[w.start] ?? 0), seconds: Number(values?.[w.seconds] ?? limits.usual), ...limits,
    fit: w.fits ? partFit(w.fits, specs ?? [], values ?? {}) : undefined,
    set: (start, seconds) => {
      onValue(w.start, start);
      onValue(w.seconds, seconds);
    },
  };
}

/**
 * How long the clip these values make will be, its own part (after the frames of a clip before), when the form says: its
 * length, else what the part of the sound or the source it is made around makes (a lip sync's recording, a swap's window).
 */
function clipSecondsOf(specs: InputSpec[] | undefined, values: Record<string, unknown> | undefined): number | null {
  if (!specs || !values) return null;
  const own = secondsOf(specs, values);
  if (own !== null) return own;
  for (const i of specs) {
    if ((i.type !== "audio" && i.type !== "clip") || !i.window?.fits || !values[i.id]) continue;
    const part = Number(values[i.window.seconds]);
    if (Number.isFinite(part) && part > 0) return partFit(i.window.fits, specs, values).clip(part);
  }
  return null;
}

export function Field({ spec, value, values, specs, options, family, model, onChange, onValue, main, bare, standard }: {
  spec: InputSpec;
  value: unknown;
  /** The whole form, for a field that goes with another one (the part painted over a picture). */
  values?: Record<string, unknown>;
  /** The form's inputs: a sound's part reads its limits off its length input, and what one clip holds off the clips it joins. */
  specs?: InputSpec[];
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
  /** A prompt whose name is said by the head over it: its own label only for screen readers. */
  bare?: boolean;
  /** What the model starts with: a number's slider marks it with a notch (a click on it goes back). */
  standard?: unknown;
}) {
  // a setting its recipe says nothing about takes the list's words (the ones every model shares, an imported workflow's)
  spec = withNote(spec);
  const id = useId();
  // the pictures the form's cast adds to this reference input when it is sent
  const cast = useCastPictures(spec.id);
  // and the voice sample it adds, when the form has none of its own
  const castVoice = useCastVoice(spec.id);
  switch (spec.type) {
    case "prompt":
      return <PromptField spec={spec} id={id} value={String(value ?? "")} values={values} onChange={onChange} bare={bare} />;

    case "model":
      return <ModelField id={id} spec={spec} value={String(value ?? "")} options={options} family={family} onChange={onChange} />;

    case "loras":
      return <Loras spec={spec} value={(value as LoraValue[] | undefined) ?? []} options={options ?? []} family={family} model={model} onChange={onChange} main={main} />;

    case "size":
      return <SizeField spec={spec} value={(value as SizeValue | undefined) ?? { width: 0, height: 0 }} values={values} onChange={onChange} />;

    case "number": {
      const n = Number(value ?? spec.default);
      const mark = typeof standard === "number" ? standard : undefined;
      return (
        <FieldRow label={spec.label} note={spec.note}>
          {spec.auto ? (
            // 0 ("by size") sits one step left of the range, so that the steps from it land on the range's own grid (1, 5, 9 …)
            <span className="flex min-w-0 items-center gap-3">
              <Slider
                label={spec.label} value={n > 0 ? n : spec.min - spec.step} min={spec.min - spec.step} max={spec.max} step={spec.step} box={false} className="grow"
                format={(v) => (v < spec.min ? spec.auto! : `${v}${spec.unit ?? ""}`)} onChange={(v) => onChange(v < spec.min ? 0 : v)}
              />
              <span className="shrink-0 font-mono text-xs text-ink-2">{n > 0 ? `${n}${spec.unit ?? ""}` : spec.auto}</span>
            </span>
          ) : (
            <Slider label={spec.label} value={n} min={spec.min} max={spec.max} step={spec.step} unit={spec.unit} mark={mark} onChange={onChange} />
          )}
          {spec.picks && (
            <div className="flex flex-wrap gap-1">
              {spec.picks.map((p) => (
                <button key={p} type="button" onClick={() => onChange(p)} className={cx("rounded-full border px-2 py-0.5 font-mono text-xs", p === n ? "border-accent bg-accent-wash text-accent" : "border-line text-ink-2 hover:bg-hover hover:text-ink")}>
                  {p}{spec.unit?.trim() ?? ""}
                </button>
              ))}
            </div>
          )}
        </FieldRow>
      );
    }

    case "toggle":
      if (spec.captions) {
        return (
          <FieldRow label={spec.label} note={spec.note} trail>
            <Segmented
              label={spec.label}
              value={value ? "on" : "off"}
              options={[{ value: "on", label: spec.captions.on }, { value: "off", label: spec.captions.off }]}
              onChange={(v) => onChange(v === "on")}
              className="w-fit"
            />
          </FieldRow>
        );
      }
      return (
        <FieldRow label={spec.label} note={spec.note} trail>
          <Toggle bare on={Boolean(value)} onChange={onChange} label={spec.label} />
        </FieldRow>
      );

    case "choice": {
      // when ComfyUI offers nothing for it (not asked yet, or it lists no file), what is set is still shown
      const all = Array.isArray(spec.options) ? [...(spec.extra ?? []), ...spec.options] : options?.length ? options : [spec.default];
      const raw = String(value ?? pickChoice(spec, options));
      // a value an older form saved shows as the option that replaced it
      const current = spec.renamed?.[raw] ?? raw;
      // a few short choices sit side by side; file names and long lists go in a list
      const few = all.length <= 4 && all.every((o) => fileLabel(o).length <= 14);
      return (
        <FieldRow label={spec.label} note={spec.note} htmlFor={few ? undefined : id} trail={few}>
          {few ? (
            <Segmented label={spec.label} value={current} options={all.map((o) => ({ value: o, label: fileLabel(o) }))} onChange={onChange} className="w-fit" />
          ) : (
            <FileSelect id={id} label={spec.label} value={current} onChange={onChange} files={all.includes(current) ? all : [current, ...all]} folder={Array.isArray(spec.options) ? undefined : FOLDER_OF[spec.options.input]} />
          )}
        </FieldRow>
      );
    }

    case "seed":
      return <SeedField id={id} label={spec.label} note={spec.note} value={Number(value ?? RANDOM_SEED)} onChange={onChange} />;

    case "image":
      if (spec.role === "mask") {
        const picture = spec.of ? values?.[spec.of] : undefined;
        return <MaskField label={spec.label} note={spec.note} picture={typeof picture === "string" ? picture : null} value={typeof value === "string" ? value : null} onChange={onChange} />;
      }
      return (
        <>
          <PictureField label={spec.label} note={spec.note} optional={Boolean(spec.optional)} value={typeof value === "string" ? value : null} onChange={onChange} />
          {/* a Motion transfer's picture, made from its driving video (motionPicture.tsx) */}
          {spec.role === "source" && specs && values && <MakeFromDriving specs={specs} values={values} current={typeof value === "string" ? value : null} onPick={onChange} />}
        </>
      );

    case "references":
      return <ReferencesField label={spec.label} note={spec.note} max={spec.max} roles={spec.roles} video={spec.media === "video"} value={(value as ReferenceValue[] | undefined) ?? []} onChange={onChange} cast={cast} />;

    case "audio":
      return (
        <SoundField
          label={spec.label} note={spec.note} optional={Boolean(spec.optional)} value={typeof value === "string" ? value : null} onChange={onChange}
          part={partProps(spec.window, specs, values, onValue)}
          cast={castVoice}
        />
      );

    case "cues":
      return <CuesField label={spec.label} note={spec.note} max={spec.max} value={(value as CueValue[] | undefined) ?? []} onChange={onChange} clipSeconds={clipSecondsOf(specs, values)} />;

    case "clip":
      return (
        <ClipField
          label={spec.label} note={spec.note} role={spec.role} optional={Boolean(spec.optional)} value={(value as ClipValue | undefined) ?? null} onChange={onChange}
          part={spec.role === "source" ? partProps(spec.window, specs, values, onValue) : undefined}
        />
      );
  }
}

