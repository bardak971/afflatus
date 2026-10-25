import { lazy, Suspense, useContext, useEffect, useMemo, type MouseEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Pin, PinOff, RotateCcw } from "lucide-react";
import { isShown, LIMITS, sameFile, typedInto, type InputSpec } from "@afflatus/core";
import { ContextMenu, groups, headLine, useMenu } from "./ContextMenu";
import { FieldNameNote } from "./fields/FieldName";
import { FieldRow } from "./fields/FieldRow";
import { useAdvice } from "./advice";
import { api, thumbUrl, type RecipeInfo, type RecipeStatus } from "./api";
import { useQuery } from "@tanstack/react-query";
import { useSettled } from "./hooks";
import { queryKeys } from "./queryKeys";
import { useModelSettings, useRecipes } from "./data";
import { Field, sameValue } from "./fields";
import { changedIn, formDefaults, layoutOf, ownValues, matchesText, pinnable, pinSaid, sectionsOf, summariesOf, thumbsOf, tuckedOf, whyHidden } from "./form";
import { InputsPart } from "./recipeForm/InputsPart";
import { ModelDefaults } from "./recipeForm/ModelDefaults";
import { OutputPart } from "./recipeForm/OutputPart";
import { CardPrompt, FormSearching, Heading, Part, PART_HEAD, TextFold, useFormAim, useParts } from "./recipeForm/Part";
import { Strip } from "./recipeForm/Strip";
import { PackNotes, usePackNotes } from "./recipeForm/packNotes";
import { SetNotes, useSetNotes } from "./recipeForm/setNotes";
import { usePinnedFields } from "./recipeForm/pinned";
import { PinnedPart, type PinnedRow } from "./recipeForm/PinnedPart";
import { useFormSearch } from "./recipeForm/useFormSearch";
import { scrollInside } from "./scrollInside";
import { plural } from "./format";
import { isFamilyFile, withOfficial } from "./officialFiles";

// what is said under a model ComfyUI does not have (with where a preset gets it): fetched the first time one is missing, not
// with the form on every first paint
const MissingModel = lazy(() => import("./PresetFiles").then((m) => ({ default: m.MissingModel })));

/** The words the form's search knows the screen's own tools by: the prompt's helpers, the model picker, the cast. */
const HELPER_WORDS = "snippets snippet designer llm roll random wildcards prompt helpers";
const MADE_WORDS = "model family operation mode presets preset image video txt2img img2img inpaint outpaint upscale";
const LOOK_WORDS = "cast look people person places style mood references";

export { mainTextOf } from "./form";

/**
 * The form of a recipe, in parts: what it is made with, what it starts from, the prompt (always open:
 * it is what changes from one try to the next), who and what is in it, what comes out, and every
 * other setting. Each part is one line until it is opened. A screen adds its own controls to a part
 * through `made`, `look` and `helpers`. Which input goes where is `layoutOf` (form.ts); what each part
 * says folded is `summariesOf`.
 */
/** A chapter a screen puts before the form's own (a timeline clip's Source, its Takes). */
export type LeadPart = { id: string; title: string; summary: ReactNode; node: ReactNode; help?: string };
/**
 * Why a setting does not apply where the form is (Form's `off`); with `value`, what stands for its value where it is not its
 * own (a clip under a recording: its part's length for Duration), said on its row and in its chapter's summary.
 */
export type OffHere = string | { why: string; value: string };

/**
 * The form a recipe's inputs make. A form whose prompt is written from parts (card #34: a swap's In the source, How they look,
 * What happens) shows the prompt they give in its prompt as sent, greyed, while that is left empty: the text a render sends.
 */
export function Form(props: {
  recipe: RecipeInfo;
  status: RecipeStatus | undefined;
  /** What the draft holds for this recipe: only what was touched. */
  stored: Record<string, unknown> | undefined;
  /** Inputs the screen fills in itself at render time (a timeline hands the clip before over): counted as set for what is shown, never stored. */
  given?: Record<string, unknown>;
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
  /** Chapters of the screen's own before every other (a timeline clip's Source and Takes): first in the strip too, in this order. */
  lead?: LeadPart | ReadonlyArray<LeadPart | undefined>;
  /** The chapters drawn first, in this order, by id; the others follow in the form's own order (a swap clip's Model, Takes, Mask). */
  first?: readonly string[];
  /** What the screen puts at the top of one of the recipe's own chapters, by its id (a swap clip's Mask: who is replaced, Show the mask). */
  chapterExtra?: Record<string, ReactNode>;
  /** What the screen adds to the Inputs chapter's frames (a timeline clip's pinned frames), with its words for the summary. */
  frameExtra?: {
    node?: ReactNode;
    summary: string;
    /** A line at the top of the chapter, whichever tab is open (a clip whose take that plays was made with other inputs). */
    head?: ReactNode;
  };
  /** Show the recipe's chapters that hold nothing yet (the import screen's preview, while sections are arranged). */
  keepEmpty?: boolean;
  /** Bring the prompt into view when the form opens on a short screen: the Create panel. A timeline clip's form stays where it is. */
  promptInView?: boolean;
  /** The machine picked to render it on (Generate on), by id; none: Auto. Its node packs are what the form's notes speak for. */
  machine?: string;
  /** No Pinned card and no pin menu: a form that is not one renders are made from (a preset's values, an import's preview). */
  noPins?: boolean;
  /**
   * Settings that do not apply where the form is, by input id, with why: shown greyed with their value, the reason in their
   * "?" (a Lip sync clip inside a run of its recording: Speech starts at). Never hidden: a row that comes and goes is never learnt.
   */
  off?: Record<string, OffHere>;
}) {
  const written = useWrittenPrompt(props.recipe, props.stored, props.given);
  const recipe = useMemo(
    () => (written ? { ...props.recipe, inputs: props.recipe.inputs.map((i) => (i.id === written.into && i.type === "prompt" ? { ...i, placeholder: written.text } : i)) } : props.recipe),
    [props.recipe, written],
  );
  return <FormOf {...props} recipe={recipe} />;
}

/**
 * What the parts give the prompt as sent, asked once they stop changing (the server writes it by the recipe's own rules), with
 * what the screen gives too (`given`: a timeline window's clip before, set at plan time): Swap motion's windows that carry on
 * are written by the motion's rules, and showed the swap's caption, which the render never sends. The field it fills is left
 * out of what is asked: it is what goes while that field is empty, so typing there asks nothing. A request overtaken by a
 * change is cancelled.
 */
export function useWrittenPrompt(recipe: RecipeInfo, stored: Record<string, unknown> | undefined, given?: Record<string, unknown>): { into: string; text: string } | null {
  const into = recipe.partsInto;
  const key = useSettled(useMemo(() => JSON.stringify(Object.fromEntries(Object.entries({ ...stored, ...given }).filter(([k]) => k !== into))), [stored, given, into]), 400);
  const asked = useQuery({
    queryKey: queryKeys.formPrompt(recipe.id, key),
    queryFn: ({ signal }) => api.formPrompt(recipe.id, JSON.parse(key) as Record<string, unknown>, { signal }),
    enabled: Boolean(recipe.partsInto),
    staleTime: Infinity,
    placeholderData: (before) => before,
  }).data;
  return asked?.into && asked.text ? { into: asked.into, text: asked.text } : null;
}

function FormOf({ recipe, status, stored, given, onChange, onClear, made, madeSummary, look, lookSummary, helpers, lead, frameExtra, chapterExtra, first, keepEmpty, promptInView, machine, noPins, off }: {
  recipe: RecipeInfo;
  status: RecipeStatus | undefined;
  /** What the draft holds for this recipe: only what was touched. */
  stored: Record<string, unknown> | undefined;
  /** Inputs the screen fills in itself at render time (a timeline hands the clip before over): counted as set for what is shown, never stored. */
  given?: Record<string, unknown>;
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
  /** Chapters of the screen's own before every other (a timeline clip's Source and Takes): first in the strip too, in this order. */
  lead?: LeadPart | ReadonlyArray<LeadPart | undefined>;
  /** The chapters drawn first, in this order, by id; the others follow in the form's own order (a swap clip's Model, Takes, Mask). */
  first?: readonly string[];
  /** What the screen puts at the top of one of the recipe's own chapters, by its id (a swap clip's Mask: who is replaced, Show the mask). */
  chapterExtra?: Record<string, ReactNode>;
  /** What the screen adds to the Inputs chapter's frames (a timeline clip's pinned frames), with its words for the summary. */
  frameExtra?: {
    node?: ReactNode;
    summary: string;
    /** A line at the top of the chapter, whichever tab is open (a clip whose take that plays was made with other inputs). */
    head?: ReactNode;
  };
  /** Show the recipe's chapters that hold nothing yet (the import screen's preview, while sections are arranged). */
  keepEmpty?: boolean;
  /** Bring the prompt into view when the form opens on a short screen: the Create panel. A timeline clip's form stays where it is. */
  promptInView?: boolean;
  /** The machine picked to render it on (Generate on), by id; none: Auto. Its node packs are what the form's notes speak for. */
  machine?: string;
  /** No Pinned card and no pin menu: a form that is not one renders are made from (a preset's values, an import's preview). */
  noPins?: boolean;
  /**
   * Settings that do not apply where the form is, by input id, with why: shown greyed with their value, the reason in their
   * "?" (a Lip sync clip inside a run of its recording: Speech starts at). Never hidden: a row that comes and goes is never learnt.
   */
  off?: Record<string, OffHere>;
}) {
  const family = useRecipes().data?.families.find((f) => f.id === recipe.family);
  const settings = useModelSettings();
  const { defaults, file, hasSaved } = useMemo(
    // a model input with nothing to pick on this ComfyUI starts on its family's official file, which the job waits for
    () => formDefaults(recipe, withOfficial(status, recipe.inputs, family), settings.data?.items ?? [], stored),
    [recipe, status, settings.data, stored, family],
  );
  const values = useMemo(() => {
    const all = { ...defaults, ...ownValues(recipe, stored) };
    // a prompt as sent holding a text the form started on (a swap's caption, the fused turbo's old preset) is empty, as the
    // render reads it: what the parts write shows there greyed, never that text as if typed (card #49)
    const into = recipe.partsInto;
    return into && typeof all[into] === "string" && all[into] && !typedInto(recipe, all[into]) ? { ...all, [into]: "" } : all;
  }, [recipe, defaults, stored]);
  // the node packs the options asked for need where the form renders: said under each (packNotes.tsx)
  const packNotes = usePackNotes(recipe, values, machine);
  // the files that do not go together (a VAE of another version, a pair swapped): said, never changed (setNotes.tsx)
  const setNotes = useSetNotes(recipe, values);
  // what decides which settings show: the values, plus what the screen will fill in itself
  const seen = given ? { ...values, ...given } : values;
  // what it will take: the same query as the Generate button's (advice.ts)
  const advice = useAdvice(recipe, values);
  // the model in use: the one picked in the form, else the one an imported workflow loads. LoRAs made for it come first.
  const picker = recipe.inputs.find((i) => i.type === "model");
  const inUse = (picker ? String(values[picker.id] ?? "") : recipe.models?.[0]) || undefined;
  /** The form names a model file this ComfyUI does not list (a preset made elsewhere, a file removed). */
  // a family's official file picked greyed says itself under its field (ModelField: Download, or fetched by the pod)
  // by its whole path, as the field and Generate match it: by its bare name, a preset's "SDXL/<official file>" that this
  // ComfyUI lacks passed here while neither of them said a thing
  const official = (file: string) => isFamilyFile(family, file);
  // listed is matched as the server matches it when it builds the job (core sameFile): the same file in another sub-folder,
  // or with the other slash, is there. An imported workflow names its model as its author kept it, and the render finds it
  const isMissingModel = (id: string) => typeof values[id] === "string" && values[id] !== "" && Array.isArray(status?.options[id]) && !sameFile(status!.options[id]!, String(values[id])) && !official(String(values[id]));
  const setPart = useParts((st) => st.set);

  // ---- the search: typed, only the settings whose name (or explanation) matches stay on the form
  const { query, setQuery, q, revealedBy } = useFormSearch(recipe);
  const layout = layoutOf(recipe, seen, q, keepEmpty);
  const { chapters, advancedMoved, promptMoved, mainText, hit, sought, texts, frames, refs, loras, out, knobs, sampling, afterSampling, upscaling, encoding, rare, hidden } = layout;
  const said = summariesOf(recipe, layout, values, { madeSummary, lookSummary, frameSummary: frameExtra?.summary, off });

  // ---- Pinned fields: the settings pinned for the model's family (every H3 form shares "h3"), first in the form. Each is a
  // live copy of the one in its section; one the form does not show now stays on the card, dimmed, saying why. An id this
  // form does not have (another H3 form's, an input a workflow lost) is skipped. While searching, the matches are where they live.
  const pins = usePinnedFields(recipe.family);
  const pinsOn = !noPins;
  const tucked = useMemo(() => tuckedOf(recipe), [recipe]);
  const sectionOfId = q ? null : sectionsOf(layout);
  const pinnedRows: PinnedRow[] = !pinsOn || q ? [] : pins.ids.flatMap((id) => {
    const spec = recipe.inputs.find((i) => i.id === id);
    if (!spec || !pinnable(spec) || tucked.has(id)) return [];
    const shown = isShown(spec, seen, recipe.inputs);
    return [{ spec, shown, from: shown ? sectionOfId?.get(id) ?? "" : whyHidden(spec, seen, recipe.inputs) || "not shown now" }];
  });
  /** A pin put before the card's row at `slot` (the rows' length: after the last), as a place in the family's whole list. */
  const movePinned = (id: string, slot: number) => {
    const before = pinnedRows[slot]?.spec.id;
    const last = pinnedRows[pinnedRows.length - 1]?.spec.id;
    pins.move(id, before !== undefined ? pins.ids.indexOf(before) : last !== undefined ? pins.ids.indexOf(last) + 1 : pins.ids.length);
  };
  // the menu of a setting, from a right-click on its name (or on a pin's grip), or from the keyboard's menu key or Shift + F10
  // on its control (a row's name is not something the keys reach). A text box keeps the browser's own menu (paste)
  const fieldMenu = useMenu<string>();
  const menuFor = (i: InputSpec, always = false) => (e: MouseEvent) => {
    const t = e.target as Element;
    const keyed = e.button === -1 || (e.clientX === 0 && e.clientY === 0);
    const typing = Boolean(t.closest?.("textarea, input:not([type=range]):not([type=checkbox]):not([type=radio]), [contenteditable='true']"));
    if (!always && !t.closest?.("[data-field-name], [data-pin-grip]") && !(keyed && !typing)) return;
    e.stopPropagation();
    fieldMenu.open(e, i.id);
  };
  // what a screen adds is not a setting, but it is looked for by name too ("snippets", "preset", "cast"): while
  // searching, it shows where it lives when its words match, and steps aside otherwise
  const helpersHit = Boolean(q && helpers) && matchesText(HELPER_WORDS, q);
  const madeHit = Boolean(q && made) && matchesText(`${MADE_WORDS} ${recipe.title}`, q);
  const lookHit = Boolean(q && look) && matchesText(LOOK_WORDS, q);

  // opened for one of its inputs (a picture handed over by Image to video, Extend, a tool): the Inputs part opens on
  // its tab, the slot comes into view and is ringed once, so the picture is seen where it went
  useEffect(() => {
    const input = useFormAim.getState().take(recipe.id);
    if (!input) {
      // the Create panel opened on a short screen: a part left open above (the Model card) can push the prompt, the field
      // worked in most, under the Generate bar; the panel scrolls to it then, and leaves it where it is otherwise
      if (!promptInView) return;
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>('[data-part="prompt"]');
        let box = el?.parentElement ?? null;
        while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
        if (el && box && el.getBoundingClientRect().top + 120 > box.getBoundingClientRect().bottom) scrollInside(el, "start");
      });
      return;
    }
    setPart("inputs:references", refs.some((i) => i.id === input));
    setPart("inputs", true, true);
    // once the opened part is drawn
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-input-id="${CSS.escape(input)}"]`);
      if (!el) return;
      scrollInside(el, "center");
      el.classList.remove("m-aim");
      void el.offsetWidth;
      el.classList.add("m-aim");
      el.addEventListener("animationend", () => el.classList.remove("m-aim"), { once: true });
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per recipe shown: the aim is taken, not watched
  }, [recipe.id]);

  // the Inputs part's folded line shows the frames chosen as small pictures before their names: a frame handed over
  // is seen at a glance without opening the part
  const chosenThumbs = thumbsOf(said.framesChosen, values);
  const inputsSummary = chosenThumbs.length ? (
    <span className="flex min-w-0 items-center gap-1.5">
      {chosenThumbs.map((t) => <img key={t.key} src={thumbUrl(t.id)} alt={t.label} draggable={false} className="h-5 w-5 shrink-0 rounded object-cover" />)}
      <span className="truncate">{said.inputsSaid}</span>
    </span>
  ) : said.inputsSaid;

  const card = useContext(CardPrompt);
  /**
   * A setting's field. `copy`: its live copy on the Pinned card, saying where it lives (the section's own is the one an aim
   * looks for by its input id); in its section, a pinned one carries a pin after its name.
   */
  const field = (i: InputSpec, { bare = false, copy }: { bare?: boolean; copy?: { from: string } } = {}) => {
    const offHere = off?.[i.id];
    if (offHere) {
      // greyed, its value as it stands (or what stands for it), nothing to change: the reason in its "?"
      const value = values[i.id] ?? defaults[i.id];
      const why = typeof offHere === "string" ? offHere : offHere.why;
      const shows = typeof offHere === "string" ? `${value === undefined || value === null ? "—" : `${String(value)}${"unit" in i && i.unit ? i.unit : ""}`} · off here` : `${offHere.value} · set here`;
      return (
        <div key={i.id} data-input-id={copy ? undefined : i.id} data-off="" className="opacity-60">
          <FieldRow label={i.label} note={why} trail>
            <span className="text-sm text-ink-3">{shows}</span>
          </FieldRow>
        </div>
      );
    }
    const pin = pinsOn && pinnable(i);
    return (
    <div key={i.id} data-input-id={copy ? undefined : i.id} onContextMenu={pin ? menuFor(i) : undefined} className="flex flex-col gap-1 rounded-lg">
      <FieldNameNote.Provider value={!pin ? null : copy ? { from: copy.from } : { pinned: pins.has(i.id) }}>
      <Field
        bare={bare}
        standard={defaults[i.id]}
        // what the screen fills in too (a timeline take's clip before): what one clip holds of a sound counts it
        spec={i} value={values[i.id]} values={seen} specs={recipe.inputs} options={status?.options[i.id]} family={family} model={inUse}
        onChange={(v) => onChange(i.id, v)}
        onValue={onChange}
        main={mainText?.type === "prompt" ? { text: String(values[mainText.id] ?? ""), style: mainText.style, set: (text) => onChange(mainText.id, text) } : undefined}
      />
      </FieldNameNote.Provider>
      {i.type === "model" && isMissingModel(i.id) && <Suspense fallback={null}><MissingModel folder={i.folder} file={String(values[i.id])} /></Suspense>}
      <PackNotes of={packNotes} input={i.id} />
      {i.type === "loras" && <SetNotes of={setNotes} input={i.id} recipe={recipe} family={family} />}
    </div>
    );
  };
  // (bare: true only; .map() passes its index in that place)
  const render = (i: InputSpec, bare?: unknown) => field(i, { bare: bare === true });
  /** A setting, with a mark and a way back when it differs from what the model starts with (on the Pinned card too: `copy`). */
  const settingOf = (i: InputSpec, copy?: { from: string }) => {
    const isChanged = !sameValue(values[i.id], defaults[i.id]);
    return (
      <div key={i.id} className={`border-l-2 pl-2.5 ${isChanged ? "border-accent" : "border-transparent"}`}>
        {field(i, { copy })}
        {isChanged && (
          <button type="button" onClick={() => onClear([i.id])} className="mt-1 rounded-md px-1 text-xs text-accent hover:underline">
            Changed · reset
          </button>
        )}
      </div>
    );
  };
  const setting = (i: InputSpec) => settingOf(i);
  const changedMark = (list: InputSpec[]) => {
    const n = changedIn(list, values, defaults).length;
    return n ? <span className="text-accent"> · {n} changed</span> : null;
  };

  const hasFrames = frames.length > 0 || Boolean(frameExtra?.node);
  // while searching, what a screen adds (the model picker, the cast, the designer) steps aside: it is not a setting
  // no reference input and no text the cast writes into: the cast is only who goes into a picture (Motion transfer's)
  const lookWithFrames = refs.length === 0 && recipe.inputs.every((i) => i.type !== "prompt" || Boolean(i.noCast));
  const hasRefs = refs.length > 0 || (Boolean(look) && !lookWithFrames && (!q || lookHit));
  const promptHit = Boolean(mainText) && (!q || hit(mainText as InputSpec) || texts.length > 0 || helpersHit);
  const found = Number(helpersHit) + Number(madeHit) + Number(lookHit) + knobs.length + loras.length + texts.length + (mainText && hit(mainText) ? 1 : 0) + frames.length + refs.length + sampling.length + afterSampling.length + upscaling.length + out.length + encoding.length + rare.length + hidden.length;

  const leads = (Array.isArray(lead) ? lead : [lead]).filter((l): l is LeadPart => Boolean(l));
  const parts = [
    ...(!q ? leads.map((l) => ({ id: l.id, label: l.title })) : []),
    ...((made && (!q || madeHit)) || knobs.length || loras.length ? [{ id: "model", label: "Model" }] : []),
    ...(promptHit && !promptMoved ? [{ id: "prompt", label: "Prompt" }] : []),
    ...(hasFrames || hasRefs ? [{ id: "inputs", label: "Inputs" }] : []),
    ...chapters.filter((ch) => (ch.id === "advanced" ? rare.length > 0 : ch.id === "prompt" ? promptHit : !q || sought(ch.items).length)).map((ch) => ({ id: ch.id, label: ch.label })),
    ...(sampling.length || afterSampling.length ? [{ id: "sampling", label: "Sampling" }] : []),
    ...(out.length || encoding.length || upscaling.length ? [{ id: "output", label: "Output" }] : []),
    ...(rare.length && !advancedMoved ? [{ id: "advanced", label: "Advanced" }] : []),
  ];
  // the chapters asked for first, in that order; the rest keep theirs (a stable sort)
  const firstIds = first ?? recipe.first;
  const rank = (id: string) => (firstIds?.includes(id) ? firstIds.indexOf(id) : firstIds?.length ?? 0);
  const ordered = <T,>(list: T[], idOf: (x: T) => string) => (firstIds?.length ? [...list].sort((a, b) => rank(idOf(a)) - rank(idOf(b))) : list);
  // the Pinned card comes first of the form's own chapters: after the screen's (a timeline clip's Source, its Takes), before the
  // rest, wherever `first` puts them; in the strip too
  const leadIds = new Set(leads.map((l) => l.id));
  const withPinned = <T,>(list: T[], idOf: (x: T) => string, pinned: T) => {
    if (!pinnedRows.length) return list;
    const at = list.findIndex((x) => !leadIds.has(idOf(x)));
    const k = at < 0 ? list.length : at;
    return [...list.slice(0, k), pinned, ...list.slice(k)];
  };
  // a few words the recipe builds its own prompt from (a swap's "who to replace"): no Designer or Snippets to write a scene into it
  const ownPrompt = mainText?.type === "prompt" && Boolean(mainText.noCast) && !mainText.designed;
  const promptBlock = mainText && promptHit && (
    // in the Create panel a card like the others, its head (with the Designer and Snippets) given with the helpers; the other texts as rows at its foot
    <div data-part="prompt" className={card ? "flex scroll-mt-12 flex-col rounded-xl border border-line-strong bg-panel" : "flex scroll-mt-12 flex-col gap-1.5"}>
      <div className={card ? "flex flex-col gap-2 px-3 pt-2.5 pb-3" : "contents"}>
        {(!q || helpersHit) && !ownPrompt && helpers}
        {isShown(mainText, seen, recipe.inputs) && (!q || hit(mainText)) && render(mainText, card && !q && mainText.type === "prompt" && !ownPrompt)}
      </div>
      {texts.length > 0 && <div className={card ? "border-t border-line py-0.5" : "-mx-3 flex flex-col"}>{texts.map((i) => <TextFold key={i.id} spec={i} value={String(values[i.id] ?? "")}>{render(i, true)}</TextFold>)}</div>}
    </div>
  );
  const advancedPart = rare.length > 0 && (
    <Part id="advanced" title="Advanced" summary={<>{plural(rare.length, "setting")}{changedMark(rare)}</>} needs={Boolean(q)}>
      {rare.map(setting)}
    </Part>
  );

  return (
    // the parts the search opens and folds change at once, without the fold's motion
    <FormSearching.Provider value={Boolean(q)}>
      <Strip parts={withPinned(ordered(parts, (x) => x.id), (x) => x.id, { id: "pinned", label: "Pinned" })} open={(id) => id !== "prompt" && setPart(id, true, true)} query={query} setQuery={setQuery} found={found} />
      {q && found === 0 && <div className="px-1 text-sm text-ink-2">No setting of this form matches “{q}”.</div>}
      {/* a pack no single option pulls in: said once, above the parts */}
      <div className="flex flex-col gap-1 px-1 empty:hidden"><PackNotes of={packNotes} input={null} /><SetNotes of={setNotes} input={null} recipe={recipe} family={family} /></div>
      {withPinned(ordered<[string, ReactNode]>([
        ...(!q ? leads.map((l): [string, ReactNode] => [l.id, <Part key={l.id} id={l.id} title={l.title} help={l.help} summary={l.summary} startOpen>{l.node}</Part>]) : []),
        ["model", ((made && (!q || madeHit)) || knobs.length > 0 || loras.length > 0) && (
          <Part key="model" id="model" title="Model" summary={said.modelSaid || recipe.title} needs={Boolean(q)}>
            {(!q || madeHit) && made}
            {knobs.map(render)}
            {loras.map(render)}
          </Part>
        )],
        ["prompt", !promptMoved && <div key="prompt-block" className="contents">{promptBlock}</div>],
        ["inputs", (
          <InputsPart
            key="inputs"
            frames={frames} refs={refs} framesChosen={said.framesChosen.length} refsCount={said.refsCount} chosen={JSON.stringify([...frames, ...refs].map((i) => values[i.id] ?? null))} summary={inputsSummary} missing={said.missing}
            look={look} lookHit={lookHit} lookWithFrames={lookWithFrames} frameExtra={frameExtra} q={q} render={render}
          />
        )],
        ...chapters.map((ch): [string, ReactNode] => {
          if (ch.id === "advanced") return ["advanced", <div key="advanced" className="contents">{advancedPart}</div>];
          if (ch.id === "prompt") return ["prompt", <div key="prompt" className="contents">{promptBlock}</div>];
          const items = sought(ch.items);
          if (q && !items.length) return [ch.id, null];
          // what the chapter's switches say, for the folded line: "Hires fix on"
          const switches = items.filter((i) => i.type === "toggle").map((i) => `${i.label} ${values[i.id] ? "on" : "off"}`);
          return [ch.id, (
            <Part key={ch.id} id={ch.id} title={ch.label} help={ch.help} needs={Boolean(q)} summary={<>{!ch.items.length ? "empty: drag settings into it" : switches.length ? switches.join(" · ") : plural(items.length, "setting")}{changedMark(items)}</>}>
              {!q && chapterExtra?.[ch.id]}
              {items.map(setting)}
              {!ch.items.length && <span className="text-xs text-ink-2">Nothing in this section yet. Drag settings into it under Sections; an empty section is left out of the form.</span>}
            </Part>
          )];
        }),
        ["sampling", (sampling.length > 0 || afterSampling.length > 0) && (
          <Part key="sampling" id="sampling" title="Sampling" summary={<>{said.samplingSaid}{changedMark([...sampling, ...afterSampling])}</>} needs={Boolean(q)}>
            {!q && <ModelDefaults recipe={recipe} file={file} hasSaved={hasSaved} values={values} defaults={defaults} onClear={onClear} />}
            {sampling.map(setting)}
            {/* a picture's hires fix: the second pass, after the sampler it re-samples with */}
            {afterSampling.length > 0 && <Heading title="After sampling" />}
            {afterSampling.map(setting)}
          </Part>
        )],
        ["output", (
          <OutputPart
            key="output"
            out={out} upscaling={upscaling} encoding={encoding} estimate={advice.data?.estimate} q={q} render={render} setting={setting}
            summary={<>{said.outSaid}{changedMark([...upscaling, ...encoding])}</>}
          />
        )],
        ["advanced", !advancedMoved && <div key="advanced-part" className="contents">{advancedPart}</div>],
      ], ([id]) => id), ([id]) => id, ["pinned", (
        <PinnedPart
          key="pinned"
          rows={pinnedRows}
          summary={pinnedRows.map((r) => pinSaid(r.spec, values[r.spec.id])).join(" · ")}
          draw={(spec, from) => settingOf(spec, { from })}
          menuFor={menuFor}
          onMove={movePinned}
        />
      )]).map(([, node]) => node)}
      {hidden.length > 0 && (
        <section className="flex flex-col gap-1.5 rounded-control border border-line bg-raised px-3 py-2">
          <span className={PART_HEAD}>Not shown now</span>
          {hidden.map((i) => (
            <span key={i.id} className="text-xs text-ink-2"><span className="font-semibold text-ink">{i.label}</span> · {revealedBy(i)}</span>
          ))}
        </section>
      )}
      {fieldMenu.menu && (() => {
        const id = fieldMenu.menu.subject;
        const spec = recipe.inputs.find((i) => i.id === id);
        if (!spec) return null;
        const pinned = pins.has(id);
        const k = pinnedRows.findIndex((r) => r.spec.id === id);
        const changed = !sameValue(values[id], defaults[id]);
        // only what would change something: no Move up on the first pin, no Reset on a value at its default
        const items = groups(
          [
            pinned
              ? { label: "Unpin", icon: <PinOff size={14} />, run: () => pins.unpin(id) }
              : pins.full
                ? { label: "Pin to the top", icon: <Pin size={14} />, disabled: true, note: `${LIMITS.pinnedFields} pinned for this model already: unpin one first` }
                : { label: "Pin to the top", icon: <Pin size={14} />, run: () => pins.pin(id) },
            ...(pinned && k > 0 ? [{ label: "Move up", key: "Alt+↑", icon: <ArrowUp size={14} />, run: () => movePinned(id, k - 1) }] : []),
            ...(pinned && k >= 0 && k < pinnedRows.length - 1 ? [{ label: "Move down", key: "Alt+↓", icon: <ArrowDown size={14} />, run: () => movePinned(id, k + 2) }] : []),
          ],
          // the changed mark's own reset ("Changed · reset"), from the menu
          changed && [{ label: "Reset to the model's default", icon: <RotateCcw size={14} />, run: () => onClear([id]) }],
        );
        return (
          <ContextMenu
            at={fieldMenu.menu.at}
            label={`${spec.label}, setting`}
            head={{ title: spec.label, sub: headLine("Setting", pinned && "pinned", sectionOfId?.get(id) ?? (pinned ? "not shown now" : null)) }}
            items={items}
            onClose={fieldMenu.close}
          />
        );
      })()}
    </FormSearching.Provider>
  );
}
