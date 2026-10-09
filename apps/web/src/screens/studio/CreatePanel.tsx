import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Entity } from "../../api";
import { useEntities, useFamilies, useModelSettings, useRecipes, useSetup } from "../../data";
import type { DesignerTurn } from "../../Designer";
import { WritingHelp } from "../../WritingHelp";
import { useDraft } from "../../draft";
import { Form, mainTextOf } from "../../RecipeForm";
import { formDefaults, matchFiles } from "../../form";
import { takePreset } from "../../handoff";
import { notReady } from "../../format";
import { LookBar, lookWords } from "../../LookBar";
import { CastPictures } from "../../castPictures";
import { CardPrompt, PartHead } from "../../recipeForm/Part";
import { appendTo } from "../../promptText";
import { useBanners, usePanelWidth } from "../../store";
import { cx, ErrorNote, ScrollColumn, PanelEdge } from "../../ui";
import { useFormTarget } from "../../formTarget";
import { DraftHeader } from "./DraftHeader";
import { GenerateBar } from "./GenerateBar";
import { ModelPicker, useModelPick } from "./ModelPicker";
import { PresetMenu, presetRefusal } from "./PresetMenu";
import { useGenerate } from "./useGenerate";

// the designer's panel is a chunk of its own: fetched the first time it opens
const Designer = lazy(() => import("../../Designer").then((m) => ({ default: m.Designer })));

type Preset = Extract<Entity, { kind: "preset" }>;

/**
 * The form that makes things, as a panel: the draft it is on, then the form in its parts, then the
 * button. What it makes is filed in `folder`, the one that is open beside it.
 */
export const CreatePanel = memo(function CreatePanel({ folder, onClose }: { folder: { id: string; name: string; path: string | null } | null; onClose(): void }) {
  const recipes = useRecipes();
  const setup = useSetup();
  const client = useQueryClient();
  const entities = useEntities();
  const all = recipes.data?.recipes ?? [];
  // what is offered to choose from: the families that are on. A draft keeps the model it is on, on or off.
  const families = useFamilies();
  const first = all.find((r) => families.isOn(r.family)) ?? all[0];
  const d = useDraft(first?.id);
  const draft = d.draft;
  // a draft can be on a recipe that is gone (a workflow that was removed): fall back to the first one
  const recipe = all.find((r) => r.id === draft?.recipe) ?? first;
  // the open form, for the library's menus: "Use in this draft" (formTarget.ts)
  const publish = useFormTarget((st) => st.publish);
  const formValues = recipe && draft ? draft.forms[recipe.id] : undefined;
  useEffect(() => {
    if (!recipe || !draft) { publish(null); return; }
    publish({
      recipe, values: { ...formValues }, set: (input, value) => d.setValue(recipe.id, input, value), draftId: draft.id, look: draft.look, setLook: d.setLook, generate: () => makeNow.current(),
      applyPreset: (id) => presetNow.current(id), savePreset: (name) => savePreset.mutateAsync(name),
    });
    // the form is gone with the panel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe, draft?.id, formValues, draft?.look]);
  useEffect(() => () => publish(null), [publish]);

  const comfyOnline = setup.data?.comfy.online ?? false;
  const status = setup.data?.recipes.find((r) => r.id === recipe?.id);
  const blocked = setup.isSuccess && recipe ? notReady(status, comfyOnline) : null;

  // the form as it stands, worked out once per change rather than at every draw (the prompt is typed into it)
  const settings = useModelSettings();
  const defaults = useMemo(() => (recipe ? formDefaults(recipe, status?.options, settings.data?.items ?? [], formValues).defaults : {}), [recipe, status, settings.data, formValues]);
  const whole = useMemo(() => (recipe && draft ? { ...defaults, ...formValues } : {}), [recipe, draft, defaults, formValues]);
  const send = useGenerate({ recipe, draft, defaults, folder: folder?.id, d, blocked });
  // Generate from elsewhere (the command bar), refused as the button is
  const makeNow = useRef(() => {});
  makeNow.current = () => {
    if (recipe && draft && !blocked && !send.isPending) send.mutate();
  };

  const pick = useModelPick({ recipe, draft, onPick: d.setRecipe });
  // a preset is a whole setup, kept under a name: the model, its form, who is in it
  const presets = (entities.data?.items ?? []).filter((e): e is Preset => e.kind === "preset");
  const [presetError, setPresetError] = useState<string | null>(null);
  const applyPreset = (p: Preset) => {
    const refused = presetRefusal(p, all);
    setPresetError(refused);
    if (refused) return;
    const r = p.def.recipe ? all.find((x) => x.id === p.def.recipe) : undefined;
    d.apply(p.def.recipe, r ? matchFiles(r, setup.data?.recipes.find((x) => x.id === r.id)?.options, p.def.inputs) : p.def.inputs, p.def.look ?? null);
  };
  // "Apply in Studio" on the Prompt kit: the preset it handed over, once the draft and the presets are here
  useEffect(() => {
    if (!draft || !entities.data) return;
    const id = takePreset();
    const p = id ? presets.find((x) => x.id === id) : undefined;
    if (p) applyPreset(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, entities.data]);
  // a preset applied from elsewhere (the command bar), by its id: as the preset menu does it, refused the same way
  const presetNow = useRef((_id: string): string | null => null);
  presetNow.current = (id) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return "This preset is not in the Prompt kit any more.";
    applyPreset(p);
    return presetRefusal(p, all);
  };
  const savePreset = useMutation({
    mutationFn: (name: string) => api.createEntity("preset", name, { recipe: recipe!.id, inputs: draft!.forms[recipe!.id] ?? {}, look: draft!.look }),
    onMutate: () => setPresetError(null),
    onError: (err) => setPresetError(err.message),
    onSuccess: () => client.invalidateQueries({ queryKey: ["entities"] }),
  });

  const say = useBanners((b) => b.push);
  const [designing, setDesigning] = useState(false);
  const mainText = recipe ? mainTextOf(recipe) : undefined;
  const titleOf = (x: { id: string; name: string | null; title: string }) =>
    x.name || (x.id === draft?.id && mainText ? String(draft.forms[draft.recipe]?.[mainText.id] ?? "").trim().slice(0, 60) : x.title) || "";
  const takesLook = recipe?.inputs.some((i) => i.type === "prompt" || i.type === "loras" || i.type === "references");

  const panelWidth = usePanelWidth((s) => s.width);
  return (
    <aside aria-label="Create" data-designer-stays style={{ width: panelWidth }} className="relative flex shrink-0 flex-col border-r border-line bg-panel">
      <PanelEdge side="right" />
      <DraftHeader d={d} draft={draft} titleOf={titleOf} onClose={onClose} />

      <ScrollColumn className="flex flex-col gap-2 px-3 pt-2 pb-3">
        {recipes.isError && <ErrorNote>{recipes.error.message}</ErrorNote>}
        {/* no draft open (yet): nothing is saved, nothing said */}
        {(draft || d.saving !== "saved") && (
          <span className={cx("flex items-center gap-2 px-1 text-xs", d.saving === "failed" ? "text-warn-ink" : "text-ink-3")}>
            {d.saving === "saved" ? "Draft saved" : d.saving === "saving" ? "Saving…" : `Could not save the draft${d.failure ? ` (${d.failure})` : ""}: what is on screen is kept here until it is.`}
            {d.saving === "failed" && <button type="button" onClick={d.retry} className="font-semibold underline underline-offset-2">Retry</button>}
          </span>
        )}
        {recipe && draft && (
          <CastPictures recipe={recipe} input={whole} look={draft.look}>
          <CardPrompt.Provider value>
          <Form
            key={`${draft.id}:${recipe.id}`}
            recipe={recipe}
            status={status}
            stored={formValues}
            onChange={(input, value) => d.setValue(recipe.id, input, value)}
            onClear={(inputs) => d.clearValues(recipe.id, inputs)}
            made={<ModelPicker pick={pick} recipe={recipe} presets={<PresetMenu presets={presets} onApply={applyPreset} onSave={(name) => savePreset.mutate(name)} error={presetError} />} />}
            madeSummary={pick.group ? `${pick.group.name} · ${recipe.title}` : recipe.title}
            look={takesLook ? <LookBar look={draft.look} onChange={d.setLook} recipe={recipe} input={whole} /> : undefined}
            lookSummary={takesLook ? lookWords(draft.look, entities.data?.items ?? []) : undefined}
            helpers={
              <WritingHelp
                recipe={recipe}
                text={mainText ? String(whole[mainText.id] ?? "") : ""}
                look={draft.look}
                onLook={d.setLook}
                onDesigner={() => setDesigning(true)}
                head={<PartHead>{mainText?.label ?? "Prompt"}</PartHead>}
                onInsert={(snippet) => {
                  if (mainText?.type === "prompt") d.setValue(recipe.id, mainText.id, appendTo(String(whole[mainText.id] ?? ""), snippet, mainText.style));
                }}
              />
            }
          />
          </CardPrompt.Provider>
          </CastPictures>
        )}
      </ScrollColumn>

      <GenerateBar recipe={recipe} draft={draft} whole={whole} folder={folder ? { name: folder.name, path: folder.path } : null} blocked={blocked} send={send} onCount={d.setCount} />

      {designing && recipe && draft && (
        <Suspense fallback={null}>
          {/* one conversation per draft: a reply that comes after a switch is written into the draft it was asked from */}
          <Designer
            key={draft.id}
            recipe={recipe}
            values={whole}
            look={draft.look}
            turns={draft.chat as DesignerTurn[]}
            onTurns={(turns) => void d.editDraft(draft.id, (x) => ({ ...x, chat: turns })).catch((err: Error) => say({ id: "draft:designer", tone: "bad", title: "The conversation could not be kept with its draft", text: err.message, href: "/create", go: "Open the form" }))}
            session={draft.designer}
            onSession={d.setDesigner}
            onApply={(changes) => d.setValues(recipe.id, changes)}
            draftKey={`draft:${draft.id}`}
            onClose={() => setDesigning(false)}
          />
        </Suspense>
      )}
    </aside>
  );
});
