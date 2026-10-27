import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { removedSaid } from "@afflatus/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Entity } from "../../api";
import { useEntities, useFamilies, useModelSettings, useRecipes, useSetup } from "../../data";
import type { DesignerTurn } from "../../designer/types";
import { WritingHelp } from "../../WritingHelp";
import { useDraft } from "../../draft";
import { fieldKey, ringsOf, useAgentEdits } from "../../agentEdits";
import { Form, mainTextOf } from "../../RecipeForm";
import { formDefaults, matchFiles, ownValues } from "../../form";
import { takePreset } from "../../handoff";
import { formsCanQueue, notReady } from "../../format";
import { LookBar, lookWords } from "../../LookBar";
import { CastPictures } from "../../castPictures";
import { CardPrompt, PartHead } from "../../recipeForm/Part";
import { appendTo } from "../../promptText";
import { useBanners, usePanelWidth } from "../../store";
import { ErrorNote, ScrollColumn, PanelEdge } from "../../ui";
import { useFormTarget } from "../../formTarget";
import { DraftHeader } from "./DraftHeader";
import { GenerateBar } from "./GenerateBar";
import { useWaitsOn } from "../../fields/FileSelect";
import { lacksOnlyFiles, withOfficial } from "../../officialFiles";
import { inputMissing } from "./missing";
import { ModelPicker, useModelPick } from "./ModelPicker";
import { PresetMenu, presetRefusal } from "./PresetMenu";
import { useGenerate } from "./useGenerate";
import { queryKeys } from "../../queryKeys";
import { failedBanner } from "../../sayFailed";
import { usePickedMachine } from "../../GenerateOn";

// the designer's panel is a chunk of its own: fetched the first time it opens
const Designer = lazy(() => import("../../Designer").then((m) => ({ default: m.Designer })));

type Preset = Extract<Entity, { kind: "preset" }>;

/**
 * The form that makes things, as a panel: the draft it is on, then the form in its parts, then the
 * button. What it makes is filed in `folder`, the one that is open beside it.
 */
/**
 * Where a draft nothing was done in goes when its model's family is switched off: the first recipe of a family that is on;
 * null to stay (something in it, its family on, or nowhere else to go). A draft with content keeps its model, on or off.
 */
export function untouchedMovesTo(draft: { empty: boolean } | null | undefined, recipe: { id: string; family: string } | undefined, first: { id: string; family: string } | undefined, isOn: (family: string) => boolean): string | null {
  if (!draft?.empty || !recipe || !first || recipe.id === first.id) return null;
  return !isOn(recipe.family) && isOn(first.family) ? first.id : null;
}

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
  // the machine picked in Generate on: the form's node pack notes speak for it
  const pickedOn = usePickedMachine(draft?.id);
  // a draft can be on a recipe that is gone (a workflow that was removed): fall back to the first one
  const recipe = all.find((r) => r.id === draft?.recipe) ?? first;
  // A draft nothing was done in follows the switches: a new install's first one opens on the first family (SDXL), and
  // switched off in Settings › Models it stayed in the model list, held by that untouched draft (the owner, 2026-10-23). One
  // with something in it keeps the model it is on, on or off.
  const moveTo = untouchedMovesTo(draft, recipe, first, families.isOn);
  useEffect(() => {
    if (moveTo) d.setRecipe(moveTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- moved once when it is found on a family switched off; d's setter reads the latest draft
  }, [moveTo]);
  // the open form, for the library's menus: "Use in this draft" (formTarget.ts)
  const publish = useFormTarget((st) => st.publish);
  const formValues = recipe && draft ? draft.forms[recipe.id] : undefined;
  useEffect(() => {
    if (!recipe || !draft) { publish(null); return; }
    publish({
      recipe, values: { ...formValues }, set: (input, value) => d.setValue(recipe.id, input, value), draftId: draft.id, folder: folder?.id, look: draft.look, setLook: d.setLook, generate: (machine) => makeNow.current(machine),
      applyPreset: (id) => presetNow.current(id), savePreset: (name) => savePreset.mutateAsync(name),
    });
    // the form is gone with the panel
    // eslint-disable-next-line react-hooks/exhaustive-deps -- published when the form's values change; the callbacks read the latest through refs
  }, [recipe, draft?.id, formValues, draft?.look, folder?.id]);
  useEffect(() => () => publish(null), [publish]);

  // no ComfyUI of the user's own and none answering: the forms still queue, their jobs waiting for a GPU
  const comfyOnline = formsCanQueue(setup.data?.comfy);
  const status = setup.data?.recipes.find((r) => r.id === recipe?.id);
  // a family file with an official download does not stop the form: the job waits for it where it runs
  const family = recipes.data?.families.find((f) => f.id === recipe?.family);
  const blocked = setup.isSuccess && recipe && !(comfyOnline && lacksOnlyFiles(status, recipe, family)) ? notReady(status, comfyOnline) : null;
  // what Generate says the job will wait for: a GPU (no ComfyUI of the user's own), or a file still to download here
  const waitsOn = useWaitsOn(recipe, status, family);

  // the form as it stands, worked out once per change rather than at every draw (the prompt is typed into it)
  const settings = useModelSettings();
  const defaults = useMemo(() => (recipe ? formDefaults(recipe, withOfficial(status, recipe.inputs, family), settings.data?.items ?? [], formValues).defaults : {}), [recipe, status, settings.data, formValues, family]);
  const whole = useMemo(() => (recipe && draft ? { ...defaults, ...ownValues(recipe, formValues) } : {}), [recipe, draft, defaults, formValues]);
  // a required input still empty (an img2img with no picture, an Inpaint with no mask) waits like a model that is not
  // ready: Ctrl+Enter and the command bar too
  const missing = inputMissing(recipe, whole);
  const send = useGenerate({ recipe, draft, defaults, folder: folder?.id, d, blocked: blocked ?? missing });
  // Generate from elsewhere (the command bar), refused as the button is
  const makeNow = useRef((_machine?: string) => {});
  makeNow.current = (machine) => {
    if (recipe && draft && !blocked && !missing && !send.isPending) send.mutate(machine);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per draft, when the presets are read: the preset is taken, not watched
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
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.entities() }),
  });

  const say = useBanners((b) => b.push);
  // the fields an MCP token changed, ringed until the user edits them (agentEdits.ts)
  const draftRings = useAgentEdits((st) => (draft ? st.rings[draft.id] : undefined));
  const agentRings = useMemo(() => (recipe ? ringsOf(draftRings, recipe.id) : {}), [draftRings, recipe]);
  const editedHere = (inputs: string[]) => {
    if (draft && recipe) useAgentEdits.getState().clear(draft.id, inputs.map((i) => fieldKey(recipe.id, i)));
  };
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
        {/* saved and saving are a mark in the header (DraftHeader); a failure says why here, with the way to try again */}
        {d.saving === "failed" && (
          <span role="alert" className="flex items-center gap-2 px-1 text-xs text-warn-ink">
            {`Not saved${d.failure ? ` (${d.failure})` : ""}: what is on screen is kept here until it is.`}
            <button type="button" onClick={d.retry} className="font-semibold underline underline-offset-2">Retry</button>
          </span>
        )}
        {/* a draft made with a model taken out of Afflatus opens on another: said, its own settings kept */}
        {draft && !all.some((r) => r.id === draft.recipe) && removedSaid(draft.recipe) && (
          <span className="px-1 text-xs text-warn-ink">Made with {removedSaid(draft.recipe)}: its settings are kept; pick another model below.</span>
        )}
        {recipe && draft && (
          <CastPictures recipe={recipe} input={whole} look={draft.look}>
          <CardPrompt.Provider value>
          <Form
            key={`${draft.id}:${recipe.id}`}
            promptInView
            machine={pickedOn?.id}
            recipe={recipe}
            status={status}
            stored={formValues}
            // bound to this draft: a picture still uploading when another draft is opened lands in the one it was put in
            agentRings={agentRings}
            onChange={(input, value) => void (editedHere([input]), d.editDraft(draft.id, (x) => ({ ...x, forms: { ...x.forms, [recipe.id]: { ...x.forms[recipe.id], [input]: value } } })).catch((err: unknown) => say(failedBanner({ id: "draft:late", once: true, href: "/create", go: "Open the form" }, "A picture could not be put in its draft", err))))}
            onClear={(inputs) => (editedHere(inputs), d.clearValues(recipe.id, inputs))}
            made={<ModelPicker pick={pick} recipe={recipe} presets={<PresetMenu presets={presets} current={{ recipe: recipe.id, values: whole }} onApply={applyPreset} onSave={(name) => savePreset.mutate(name)} error={presetError} />} />}
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
                // the prompt's card is headed apart from its field: an MCP token's name goes after its title, as after a field's
                head={<PartHead>{mainText?.label ?? "Prompt"}{mainText && agentRings[mainText.id] && <span className="ml-1.5 font-medium normal-case tracking-normal text-picture">· {agentRings[mainText.id]}</span>}</PartHead>}
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

      <GenerateBar recipe={recipe} draft={draft} whole={whole} folder={folder ? { name: folder.name, path: folder.path } : null} blocked={blocked} waits={waitsOn(whole)} send={send} onCount={d.setCount} />

      {designing && recipe && draft && (
        <Suspense fallback={null}>
          {/* one conversation per draft: a reply that comes after a switch is written into the draft it was asked from */}
          <Designer
            key={draft.id}
            recipe={recipe}
            values={whole}
            look={draft.look}
            turns={draft.chat as DesignerTurn[]}
            onTurns={(turns) => void d.editDraft(draft.id, (x) => ({ ...x, chat: turns })).catch((err: unknown) => say(failedBanner({ id: "draft:designer", once: true, href: "/create", go: "Open the form" }, "The conversation could not be kept with its draft", err)))}
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
