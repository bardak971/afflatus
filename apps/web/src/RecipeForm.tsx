import { lazy, Suspense, useContext, useEffect, useMemo, type ReactNode } from "react";
import { isShown, type InputSpec } from "@afflatus/core";
import { useAdvice } from "./advice";
import { thumbUrl, type RecipeInfo, type RecipeStatus } from "./api";
import { useModelSettings, useRecipes } from "./data";
import { Field, sameValue } from "./fields";
import { changedIn, formDefaults, layoutOf, matchesText, summariesOf, thumbsOf } from "./form";
import { InputsPart } from "./recipeForm/InputsPart";
import { ModelDefaults } from "./recipeForm/ModelDefaults";
import { OutputPart } from "./recipeForm/OutputPart";
import { CardPrompt, FormSearching, Part, TextFold, useFormAim, useParts } from "./recipeForm/Part";
import { Strip } from "./recipeForm/Strip";
import { useFormSearch } from "./recipeForm/useFormSearch";
import { scrollInside } from "./scrollInside";
import { plural } from "./format";

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
export function Form({ recipe, status, stored, given, onChange, onClear, made, madeSummary, look, lookSummary, helpers, lead, frameExtra, keepEmpty }: {
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
  /** A chapter of the screen's own before every other (a timeline clip's Takes): first in the strip too. */
  lead?: { id: string; title: string; summary: ReactNode; node: ReactNode; help?: string };
  /** What the screen adds to the Inputs chapter's frames (a timeline clip's pinned frames), with its words for the summary. */
  frameExtra?: { node: ReactNode; summary: string };
  /** Show the recipe's chapters that hold nothing yet (the import screen's preview, while sections are arranged). */
  keepEmpty?: boolean;
}) {
  const family = useRecipes().data?.families.find((f) => f.id === recipe.family);
  const settings = useModelSettings();
  const { defaults, file, hasSaved } = useMemo(
    () => formDefaults(recipe, status?.options, settings.data?.items ?? [], stored),
    [recipe, status, settings.data, stored],
  );
  const values = useMemo(() => ({ ...defaults, ...stored }), [defaults, stored]);
  // what decides which settings show: the values, plus what the screen will fill in itself
  const seen = given ? { ...values, ...given } : values;
  // what it will take: the same query as the Generate button's (advice.ts)
  const advice = useAdvice(recipe, values);
  // the model in use: the one picked in the form, else the one an imported workflow loads. LoRAs made for it come first.
  const picker = recipe.inputs.find((i) => i.type === "model");
  const inUse = (picker ? String(values[picker.id] ?? "") : recipe.models?.[0]) || undefined;
  /** The form names a model file this ComfyUI does not list (a preset made elsewhere, a file removed). */
  const isMissingModel = (id: string) => typeof values[id] === "string" && values[id] !== "" && Array.isArray(status?.options[id]) && !status!.options[id]!.includes(String(values[id]));
  const setPart = useParts((st) => st.set);

  // ---- the search: typed, only the settings whose name (or explanation) matches stay on the form
  const { query, setQuery, q, revealedBy } = useFormSearch(recipe);
  const layout = layoutOf(recipe, seen, q, keepEmpty);
  const { chapters, advancedMoved, promptMoved, mainText, hit, sought, texts, frames, refs, loras, out, knobs, sampling, upscaling, encoding, rare, hidden } = layout;
  const said = summariesOf(recipe, layout, values, { madeSummary, lookSummary, frameSummary: frameExtra?.summary });
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
      if (!card) return;
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
  // (bare: true only; .map() passes its index in that place)
  const render = (i: InputSpec, bare?: unknown) => (
    <div key={i.id} data-input-id={i.id} className="flex flex-col gap-1 rounded-lg">
      <Field
        bare={bare === true}
        standard={defaults[i.id]}
        spec={i} value={values[i.id]} values={values} options={status?.options[i.id]} family={family} model={inUse}
        onChange={(v) => onChange(i.id, v)}
        onValue={onChange}
        main={mainText?.type === "prompt" ? { text: String(values[mainText.id] ?? ""), style: mainText.style, set: (text) => onChange(mainText.id, text) } : undefined}
      />
      {i.type === "model" && isMissingModel(i.id) && <Suspense fallback={null}><MissingModel folder={i.folder} file={String(values[i.id])} /></Suspense>}
    </div>
  );
  /** A setting, with a mark and a way back when it differs from what the model starts with. */
  const setting = (i: InputSpec) => {
    const isChanged = !sameValue(values[i.id], defaults[i.id]);
    return (
      <div key={i.id} className={`border-l-2 pl-2.5 ${isChanged ? "border-accent" : "border-transparent"}`}>
        {render(i)}
        {isChanged && (
          <button type="button" onClick={() => onClear([i.id])} className="mt-1 rounded-md px-1 text-xs text-accent hover:underline">
            Changed · reset
          </button>
        )}
      </div>
    );
  };
  const changedMark = (list: InputSpec[]) => {
    const n = changedIn(list, values, defaults).length;
    return n ? <span className="text-accent"> · {n} changed</span> : null;
  };

  const hasFrames = frames.length > 0 || Boolean(frameExtra);
  // while searching, what a screen adds (the model picker, the cast, the designer) steps aside: it is not a setting
  const hasRefs = refs.length > 0 || (Boolean(look) && (!q || lookHit));
  const promptHit = Boolean(mainText) && (!q || hit(mainText as InputSpec) || texts.length > 0 || helpersHit);
  const found = Number(helpersHit) + Number(madeHit) + Number(lookHit) + knobs.length + loras.length + texts.length + (mainText && hit(mainText) ? 1 : 0) + frames.length + refs.length + sampling.length + upscaling.length + out.length + encoding.length + rare.length + hidden.length;

  const parts = [
    ...(lead && !q ? [{ id: lead.id, label: lead.title }] : []),
    ...((made && (!q || madeHit)) || knobs.length || loras.length ? [{ id: "model", label: "Model" }] : []),
    ...(promptHit && !promptMoved ? [{ id: "prompt", label: "Prompt" }] : []),
    ...(hasFrames || hasRefs ? [{ id: "inputs", label: "Inputs" }] : []),
    ...chapters.filter((ch) => (ch.id === "advanced" ? rare.length > 0 : ch.id === "prompt" ? promptHit : !q || sought(ch.items).length)).map((ch) => ({ id: ch.id, label: ch.label })),
    ...(sampling.length ? [{ id: "sampling", label: "Sampling" }] : []),
    ...(out.length || encoding.length || upscaling.length ? [{ id: "output", label: "Output" }] : []),
    ...(rare.length && !advancedMoved ? [{ id: "advanced", label: "Advanced" }] : []),
  ];
  const promptBlock = mainText && promptHit && (
    // in the Create panel a card like the others, its head (with the Designer and Snippets) given with the helpers; the other texts as rows at its foot
    <div data-part="prompt" className={card ? "flex scroll-mt-12 flex-col rounded-xl border border-line-strong bg-panel" : "flex scroll-mt-12 flex-col gap-1.5"}>
      <div className={card ? "flex flex-col gap-2 px-3 pt-2.5 pb-3" : "contents"}>
        {(!q || helpersHit) && helpers}
        {isShown(mainText, seen, recipe.inputs) && (!q || hit(mainText)) && render(mainText, card && !q && mainText.type === "prompt")}
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
      <Strip parts={parts} open={(id) => id !== "prompt" && setPart(id, true, true)} query={query} setQuery={setQuery} found={found} />
      {q && found === 0 && <div className="px-1 text-sm text-ink-2">No setting of this form matches “{q}”.</div>}
      {lead && !q && <Part id={lead.id} title={lead.title} help={lead.help} summary={lead.summary} startOpen>{lead.node}</Part>}
      {((made && (!q || madeHit)) || knobs.length > 0 || loras.length > 0) && (
        <Part id="model" title="Model" summary={said.modelSaid || recipe.title} needs={Boolean(q)}>
          {(!q || madeHit) && made}
          {knobs.map(render)}
          {loras.map(render)}
        </Part>
      )}
      {!promptMoved && promptBlock}
      <InputsPart
        frames={frames} refs={refs} framesChosen={said.framesChosen.length} refsCount={said.refsCount} chosen={JSON.stringify([...frames, ...refs].map((i) => values[i.id] ?? null))} summary={inputsSummary} missing={said.missing}
        look={look} lookHit={lookHit} frameExtra={frameExtra} q={q} render={render}
      />
      {chapters.map((ch) => {
        if (ch.id === "advanced") return <div key="advanced" className="contents">{advancedPart}</div>;
        if (ch.id === "prompt") return <div key="prompt" className="contents">{promptBlock}</div>;
        const items = sought(ch.items);
        if (q && !items.length) return null;
        // what the chapter's switches say, for the folded line: "Hires fix on"
        const switches = items.filter((i) => i.type === "toggle").map((i) => `${i.label} ${values[i.id] ? "on" : "off"}`);
        return (
          <Part key={ch.id} id={ch.id} title={ch.label} help={ch.help} needs={Boolean(q)} summary={<>{!ch.items.length ? "empty: drag settings into it" : switches.length ? switches.join(" · ") : plural(items.length, "setting")}{changedMark(items)}</>}>
            {items.map(setting)}
            {!ch.items.length && <span className="text-xs text-ink-2">Nothing in this section yet. Drag settings into it under Sections; an empty section is left out of the form.</span>}
          </Part>
        );
      })}
      {sampling.length > 0 && (
        <Part id="sampling" title="Sampling" summary={<>{said.samplingSaid}{changedMark(sampling)}</>} needs={Boolean(q)}>
          {!q && <ModelDefaults recipe={recipe} file={file} hasSaved={hasSaved} values={values} defaults={defaults} onClear={onClear} />}
          {sampling.map(setting)}
        </Part>
      )}
      <OutputPart
        out={out} upscaling={upscaling} encoding={encoding} estimate={advice.data?.estimate} q={q} render={render} setting={setting}
        summary={<>{said.outSaid}{changedMark([...upscaling, ...encoding])}</>}
      />
      {!advancedMoved && advancedPart}
      {hidden.length > 0 && (
        <section className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-raised px-3 py-2">
          <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">Not shown now</span>
          {hidden.map((i) => (
            <span key={i.id} className="text-xs text-ink-2"><span className="font-semibold text-ink">{i.label}</span> · {revealedBy(i)}</span>
          ))}
        </section>
      )}
    </FormSearching.Provider>
  );
}
