import { useId, type ReactNode } from "react";
import { pickChoice, RANDOM_SEED, type ClipValue, type InputSpec, type LoraValue, type ReferenceValue, type SizeValue } from "@afflatus/core";
import type { FamilyInfo } from "./api";
import { useCastPictures } from "./castPictures";
import { FileSelect, FOLDER_OF } from "./fields/FileSelect";
import { Label } from "./fields/Label";
import { Loras, type MainText } from "./fields/Loras";
import { PromptField } from "./fields/PromptField";
import { SeedField } from "./fields/SeedField";
import { SizeField } from "./fields/SizeField";
import { withNote } from "./fieldNotes";
import { fileLabel } from "./format";
import { MaskField } from "./MaskField";
import { Slider } from "./Slider";
import { ClipField, PictureField, ReferencesField, SoundField } from "./PictureField";
import { useExplain } from "./store";
import { cx, NumberBox, Segmented, Toggle, Help, Note } from "./ui";

export { useLoraWordsOf } from "./fields/Loras";

/**
 * One control per input type. This file is the only place that knows how an input is drawn: a recipe
 * only says which inputs it has, so a new recipe needs nothing here. The fields of their own (a prompt,
 * a size, LoRAs, a seed, a file) are in fields/.
 */

// where an input's value starts, and when two values are the same: in form.ts, which works with them without drawing a
// field (imported from here, form.ts would load every field, and through them the viewer, with the app)
export { defaultOf, sameValue } from "./form";

export function Field({ spec, value, values, options, family, model, onChange, onValue, main, bare, standard }: {
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
  /** A prompt whose name is said by the head over it: its own label only for screen readers. */
  bare?: boolean;
  /** What the model starts with: a number's slider marks it with a notch (a click on it goes back). */
  standard?: unknown;
}) {
  // a setting its recipe says nothing about takes the list's words (the ones every model shares, an imported workflow's)
  spec = withNote(spec);
  const id = useId();
  const explain = useExplain((st) => st.on);
  // the pictures the form's cast adds to this reference input when it is sent
  const cast = useCastPictures(spec.id);
  switch (spec.type) {
    case "prompt":
      return <PromptField spec={spec} id={id} value={String(value ?? "")} values={values} onChange={onChange} bare={bare} />;

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
      const mark = typeof standard === "number" ? standard : undefined;
      return (
        <FieldRow label={spec.label} note={spec.note}>
          <Slider label={spec.label} value={n} min={spec.min} max={spec.max} step={spec.step} unit={spec.unit} mark={mark} onChange={onChange} />
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
          <FieldRow label={spec.label} note={spec.note}>
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
        <FieldRow label={spec.label} note={spec.note}>
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
        <FieldRow label={spec.label} note={spec.note} htmlFor={few ? undefined : id}>
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

/**
 * A compact setting on one row: its name on the left (with its ? or, while forms explain themselves, its
 * line under it), the control on the right. Numbers, switches and choices are drawn so; pictures, prompts and
 * lists of files keep their own stacked shape.
 */
export function FieldRow({ label, note, htmlFor, stack, children }: { label: string; note?: string; htmlFor?: string; /** The control always under its label: one that needs the row's whole width (a range of a clip with its figures under it). */ stack?: boolean; children: ReactNode }) {
  const explain = useExplain((st) => st.on);
  return (
    // in the timeline editor's column dragged narrow (its container, "column"), the control goes under its label: side
    // by side, a switch or a picker beside a 124 px label was cut
    <div className={cx("grid min-h-11 items-center gap-x-3 gap-y-1", stack ? "grid-cols-1 py-1" : "grid-cols-[124px_minmax(0,1fr)] @max-[21rem]/column:grid-cols-1 @max-[21rem]/column:py-1")}>
      <span className="flex min-w-0 items-center justify-between gap-1.5">
        {htmlFor ? <label htmlFor={htmlFor} className="truncate font-semibold">{label}</label> : <span className="truncate font-semibold">{label}</span>}
        {/* pinned to the column's right edge: the ?s of a card line up */}
        {note && !explain && <Help text={note} title={label} />}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
      {explain && note && <span className="col-span-full text-xs text-ink-2">{note}</span>}
    </div>
  );
}
