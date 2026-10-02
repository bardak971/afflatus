import { useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isShown, secondsInput, type InputSpec, type LoraValue, type ReferenceValue, type SizeValue } from "@studai/core";
import { api, type RecipeInfo, type RecipeStatus } from "./api";
import { useModelSettings, useRecipes } from "./data";
import { DRAG_HAS_SOUND, DRAG_PICTURE, DRAG_SOUND, DRAG_VIDEO, useDragged } from "./dragging";
import { Field, sameValue } from "./fields";
import { formDefaults } from "./form";
import { fileLabel } from "./format";
import { Button, cx, ErrorNote } from "./ui";

/**
 * Which parts of a form are open. Kept for every form and every visit: a part folded once stays
 * folded, so the form shows what is being worked on and one line for the rest.
 */
const useParts = create<{ open: Record<string, boolean>; set(id: string, open: boolean): void }>()(
  persist((set) => ({ open: {}, set: (id, open) => set((s) => ({ open: { ...s.open, [id]: open } })) }), { name: "studai.form.parts" }),
);

/**
 * One part of a form. Folded, it is one line that says what it holds, so it need not be opened to be
 * checked; open, its fields are under that line. A part that needs something from the user (a picture
 * that is not chosen yet) is open whatever was remembered.
 */
export function Part({ id, title, summary, warn, needs, children }: {
  id: string;
  title: string;
  /** What it holds, in a few words. */
  summary: ReactNode;
  /** A word about something in it that is heavy or wrong, shown while it is folded too. */
  warn?: string;
  needs?: boolean;
  children: ReactNode;
}) {
  const kept = useParts((s) => s.open[id] ?? false);
  const set = useParts((s) => s.set);
  const open = kept || Boolean(needs);
  return (
    <section className={cx("rounded-[10px] border", open ? "border-line-strong" : "border-line bg-raised")}>
      <button type="button" aria-expanded={open} onClick={() => set(id, !open)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">{title}</span>
          <span className={cx("truncate", open ? "text-xs text-ink-2" : "font-semibold")}>{summary}</span>
          {warn && <span className="truncate text-xs text-warn-ink">{warn}</span>}
        </span>
        <ChevronDown size={15} className={cx("shrink-0 text-ink-2 transition-transform", open && "rotate-180")} />
      </button>
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
        <button type="button" onClick={() => set(id, false)} className="self-end rounded-md px-1 text-xs text-ink-2 hover:text-ink hover:underline">Fold it away</button>
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
export function Form({ recipe, status, stored, onChange, onClear, made, madeSummary, look, lookSummary, helpers }: {
  recipe: RecipeInfo;
  status: RecipeStatus | undefined;
  /** What the draft holds for this recipe: only what was touched. */
  stored: Record<string, unknown> | undefined;
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
  const shown = recipe.inputs.filter((i) => isShown(i, values) && !tucked.has(i.id));
  // where a LoRA's trigger words go, and the one text that is always open
  const mainText = mainTextOf(recipe);
  // what is heavy for the card: asked again only when a setting changes, not while text is typed
  const settingsOnly = useMemo(() => {
    const texts = new Set(recipe.inputs.filter((i) => i.type === "prompt").map((i) => i.id));
    return Object.fromEntries(Object.entries(values).filter(([k, v]) => !texts.has(k) && v !== undefined));
  }, [recipe, values]);
  const adviceKey = JSON.stringify(settingsOnly);
  const advice = useQuery({
    queryKey: ["advice", recipe.id, adviceKey],
    queryFn: () => api.advice(recipe.id, { ...Object.fromEntries(recipe.inputs.filter((i) => i.type === "prompt" && !i.optional).map((i) => [i.id, "x"])), ...settingsOnly }),
    staleTime: 60_000,
  });
  const word = (id: string) => advice.data?.items.find((a) => a.input === id);
  /** The first thing said about one of these inputs: shown on a folded part, so that it is not missed. */
  const warnOf = (inputs: InputSpec[]) => inputs.map((i) => word(i.id)?.text).find(Boolean);
  // the model in use: the one picked in the form, else the one an imported workflow loads. LoRAs made for it come first.
  const picker = recipe.inputs.find((i) => i.type === "model");
  const inUse = (picker ? String(values[picker.id] ?? "") : recipe.models?.[0]) || undefined;
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
      </div>
    );
  };

  // ---- which input goes in which part
  // the negative prompt sits under the prompt in every form that has one, wherever its recipe filed it
  // (a form with no prompt of its own keeps it with its other settings)
  const underPrompt = (i: InputSpec) => i.type === "prompt" && i.id === "negative" && Boolean(mainText);
  const front = shown.filter((i) => !i.advanced || underPrompt(i));
  const advanced = shown.filter((i) => i.advanced && !underPrompt(i));
  const length = secondsInput(recipe.inputs);
  const isOut = (i: InputSpec) => i.type === "size" || i.type === "seed" || (i.type === "number" && (i.id === length?.id || i.unit?.trim() === "p"));
  const texts = front.filter((i): i is Extract<InputSpec, { type: "prompt" }> => i.type === "prompt" && i.id !== mainText?.id);
  const from = front.filter((i) => i.type === "image" || i.type === "clip");
  const inIt = front.filter((i) => i.type === "references" || i.type === "audio" || i.type === "loras");
  const out = front.filter(isOut);
  // the model's file and the operation's own settings (how much an img2img may redraw, which upscaler)
  const knobs = front.filter((i) => i.type === "model" || ((i.type === "number" || i.type === "toggle" || i.type === "choice") && !isOut(i)));

  // while something of the library is dragged, a part that has a place for it is open: the place is there to be dropped on
  const dragged = useDragged((s) => s.types);
  const takes = (i: InputSpec) =>
    (i.type === "image" && i.role !== "mask" && dragged.includes(DRAG_PICTURE)) ||
    (i.type === "clip" && dragged.includes(DRAG_VIDEO)) ||
    (i.type === "references" && dragged.includes(i.media === "video" ? DRAG_VIDEO : DRAG_PICTURE)) ||
    (i.type === "audio" && (dragged.includes(DRAG_SOUND) || dragged.includes(DRAG_HAS_SOUND)));

  // ---- what each part holds, in a few words
  const said = (i: InputSpec): string => {
    const v = values[i.id];
    if (i.type === "model") return fileLabel(String(v ?? ""));
    if (i.type === "number") return `${i.label.toLowerCase()} ${v}${i.unit ?? ""}`;
    if (i.type === "toggle") return v ? i.label.toLowerCase() : "";
    if (i.type === "choice") return fileLabel(String(v ?? ""));
    return "";
  };
  const madeWith = [madeSummary, ...knobs.map(said)].filter(Boolean).join(" · ");
  const chosen = from.filter((i) => values[i.id]);
  const missing = from.some((i) => (i.type === "image" || i.type === "clip") && !i.optional && !values[i.id]);
  const fromSaid = chosen.length ? chosen.map((i) => i.label).join(", ") : missing ? "Nothing chosen yet" : "Nothing: it starts from the prompt alone";
  const inSaid = [
    lookSummary,
    ...inIt.map((i) => {
      const v = values[i.id];
      if (i.type === "references") return Array.isArray(v) && v.length ? count((v as ReferenceValue[]).length, i.media === "video" ? "reference video" : "reference picture") : "";
      if (i.type === "audio") return v ? i.label.toLowerCase() : "";
      return isLoras(v) && v.length ? count(v.length, "LoRA") : "";
    }),
  ].filter(Boolean).join(" · ") || "Nobody and nothing added";
  const outSaid = out.map((i) => {
    const v = values[i.id];
    if (i.type === "size") {
      const s = v as SizeValue | undefined;
      const shape = i.shapes.find((x) => x.width === s?.width && x.height === s?.height);
      return i.ratioOnly ? shape?.label ?? `${s?.width} : ${s?.height}` : `${shape ? `${shape.label} ` : ""}${s?.width} × ${s?.height}`;
    }
    if (i.type === "seed") return Number(v ?? -1) === -1 ? "random seed" : `seed ${v}`;
    if (i.type === "number") return `${v}${i.unit ?? ""}`;
    return "";
  }).filter(Boolean).join(" · ");
  const changed = advanced.filter((i) => !sameValue(values[i.id], defaults[i.id]));
  const key = (id: string) => advanced.find((i) => i.id === id);
  const allSaid = [
    key("steps") ? `${values.steps} steps` : "",
    key("cfg") ? `CFG ${values.cfg}` : "",
    // a sampler left to the recipe says so: "Auto" alone would say nothing
    key("sampler") ? (values.sampler === "Auto" ? "sampler picked for you" : fileLabel(String(values.sampler ?? ""))) : "",
  ].filter(Boolean).join(" · ") || count(advanced.length, "setting");

  // what belongs to the model, whatever part of the form it is in (the size and the negative prompt are up front)
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

  return (
    <>
      {(made || knobs.length > 0) && (
        <Part id="made" title="Made with" summary={madeWith || recipe.title} warn={warnOf(knobs)}>
          {made}
          {knobs.map(render)}
        </Part>
      )}
      {from.length > 0 && (
        <Part id="from" title="Starts from" summary={fromSaid} warn={warnOf(from)} needs={missing || from.some(takes)}>
          {from.map(render)}
        </Part>
      )}
      {mainText && (
        <div className="flex flex-col gap-1.5">
          {helpers}
          {isShown(mainText, values) && render(mainText)}
          {texts.map((i) => <TextFold key={i.id} spec={i} value={String(values[i.id] ?? "")}>{render(i)}</TextFold>)}
        </div>
      )}
      {(look || inIt.length > 0) && (
        <Part id="in" title="In it" summary={inSaid} warn={warnOf(inIt)} needs={inIt.some(takes)}>
          {look}
          {inIt.map(render)}
        </Part>
      )}
      {out.length > 0 && (
        <Part id="out" title="Comes out as" summary={outSaid} warn={warnOf(out)}>
          {out.map(render)}
        </Part>
      )}
      {advanced.length > 0 && (
        <Part
          id="all"
          title="All settings"
          summary={<>{allSaid}{changed.length > 0 && <span className="text-accent"> · {changed.length} changed</span>}</>}
          warn={warnOf(advanced)}
        >
          {perModel.length > 0 && file && (
            <div className="flex flex-col gap-2 text-xs text-ink-2">
              <span>
                {differs.length
                  ? `${differs.length} setting${differs.length > 1 ? "s differ" : " differs"} from what ${model} starts with. They apply to this draft only.`
                  : hasSaved
                    ? `These are the settings you saved for ${model}.`
                    : `Nothing is saved for ${model} yet: these are the usual starting values.`}
              </span>
              <span className="flex flex-wrap gap-1.5">
                {differs.length > 0 && <Button size="sm" tone="quiet" onClick={() => save.mutate()} disabled={save.isPending}>Save for {model}</Button>}
                {differs.length > 0 && <Button size="sm" onClick={() => onClear(differs.map((i) => i.id))}>Put all back</Button>}
                {hasSaved && !differs.length && <Button size="sm" onClick={() => forget.mutate()} disabled={forget.isPending}>Forget what is saved for it</Button>}
              </span>
              {(save.isError || forget.isError) && <ErrorNote>{(save.error ?? forget.error)?.message}</ErrorNote>}
            </div>
          )}
          {advanced.map((i) => {
            const isChanged = !sameValue(values[i.id], defaults[i.id]);
            return (
              <div key={i.id} className={cx("border-l-2 pl-2.5", isChanged ? "border-accent" : "border-transparent")}>
                {render(i)}
                {isChanged && (
                  <button type="button" onClick={() => onClear([i.id])} className="mt-1 rounded-md px-1 text-xs text-accent hover:underline">
                    Changed · put it back
                  </button>
                )}
              </div>
            );
          })}
        </Part>
      )}
    </>
  );
}
