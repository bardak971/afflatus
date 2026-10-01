import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, ChevronDown, ChevronUp, Minus, Pencil, Plus, Workflow, X } from "lucide-react";
import { isShown, type InputSpec } from "@studai/core";
import { api, ApiError, type Asset, type RecipeInfo, type RecipeStatus, type RunningJob } from "../api";
import { useAssets, useEntities, useEstimates, useModelSettings, useQueue, useRecipes, useSetup } from "../data";
import { Designer, WritingHelp, type DesignerTurn } from "../Designer";
import { LivePreview } from "../LivePreview";
import { LookBar } from "../LookBar";
import { Select } from "../Select";
import { estimateFor } from "../estimate";
import { useDraft } from "../draft";
import { Field, sameValue } from "../fields";
import { formDefaults } from "../form";
import { carryOver, modelGroups } from "../picker";
import { about, aboutMs, fileLabel, notReady, phaseLabel, recipeLabel, when } from "../format";
import { Bar, Button, cx, Empty, ErrorNote, Segmented } from "../ui";
import { Viewer } from "../Viewer";
import { Tile } from "./Library";

function LiveTile({ job }: { job: RunningJob }) {
  return (
    <div className="relative flex aspect-[3/4] flex-col items-center justify-center gap-2 overflow-hidden rounded-[10px] border border-line-strong bg-panel">
      <LivePreview job={job} className="absolute inset-0 h-full w-full object-cover opacity-80" />
      <div className="relative flex w-full flex-col items-center gap-2 bg-ground/60 px-3 py-2 text-center">
        <div className="font-semibold">{phaseLabel(job.phase)}</div>
        <div className="text-xs text-ink-2">{job.steps ? `step ${job.step} of ${job.steps}` : "starting"}{job.eta ? ` · ${about(job.eta)}` : ""}</div>
        <div className="w-4/5"><Bar value={job.progress * 100} /></div>
      </div>
    </div>
  );
}

export function Form({ recipe, status, stored, onChange, onClear }: {
  recipe: RecipeInfo;
  status: RecipeStatus | undefined;
  /** What the draft holds for this recipe: only what was touched. */
  stored: Record<string, unknown> | undefined;
  onChange(input: string, value: unknown): void;
  /** Let these inputs follow the defaults again. */
  onClear(inputs: string[]): void;
}) {
  const [more, setMore] = useState(false);
  const client = useQueryClient();
  const family = useRecipes().data?.families.find((f) => f.id === recipe.family);
  const settings = useModelSettings();
  const { defaults, file, hasSaved } = useMemo(
    () => formDefaults(recipe, status?.options, settings.data?.items ?? [], stored),
    [recipe, status, settings.data, stored],
  );
  const values = useMemo(() => ({ ...defaults, ...stored }), [defaults, stored]);
  const shown = recipe.inputs.filter((i) => isShown(i, values));
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
  const main = shown.filter((i) => !i.advanced);
  const advanced = shown.filter((i) => i.advanced);
  const changed = advanced.filter((i) => !sameValue(values[i.id], defaults[i.id]));
  // the model in use: the one picked in the form, else the one an imported workflow loads. LoRAs made for it come first.
  const picker = recipe.inputs.find((i) => i.type === "model");
  const inUse = (picker ? String(values[picker.id] ?? "") : recipe.models?.[0]) || undefined;
  const render = (i: InputSpec) => {
    const a = word(i.id);
    return (
      <div key={i.id} className="flex flex-col gap-1">
        <Field spec={i} value={values[i.id]} values={values} options={status?.options[i.id]} family={family} model={inUse} onChange={(v) => onChange(i.id, v)} />
        {a && <span className={cx("text-xs", a.level === "heavy" ? "font-semibold text-warn-ink" : "text-warn-ink")}>{a.level === "heavy" ? "Heavy: " : ""}{a.text}</span>}
      </div>
    );
  };

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
      {main.map(render)}
      {advanced.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={more}
            onClick={() => setMore(!more)}
            className="flex h-[38px] items-center justify-between rounded-lg border border-line bg-raised px-3 text-left"
          >
            <span className="font-medium">
              All settings
              {changed.length > 0 && <span className="text-accent"> · {changed.length} changed</span>}
              {advanced.some((i) => word(i.id)) && <span className="text-warn-ink"> · {advanced.filter((i) => word(i.id)).map((i) => word(i.id)!.text)[0]}</span>}
            </span>
            {more ? <ChevronUp size={15} className="text-ink-2" /> : <ChevronDown size={15} className="text-ink-2" />}
          </button>
          {more && (
            <div className="flex flex-col gap-3.5 rounded-lg border border-line p-3">
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
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function Create() {
  const recipes = useRecipes();
  const setup = useSetup();
  const queue = useQueue();
  const client = useQueryClient();
  const latest = useAssets({});
  const [open, setOpen] = useState<Asset | null>(null);

  const all = recipes.data?.recipes ?? [];
  const d = useDraft(all[0]?.id);
  const draft = d.draft;
  // a draft can be on a recipe that is gone (a workflow that was removed): fall back to the first one
  const recipe = all.find((r) => r.id === draft?.recipe) ?? all[0];
  const count = draft?.count ?? 1;

  const comfyOnline = setup.data?.comfy.online ?? false;
  const status = setup.data?.recipes.find((r) => r.id === recipe?.id);
  const blocked = setup.isSuccess && recipe ? notReady(status, comfyOnline) : null;

  const settings = useModelSettings();
  const send = useMutation({
    mutationFn: async () => {
      if (!recipe || !draft) return;
      // what is sent is the whole form: the starting values for what was never touched, plus the draft
      const stored = draft.forms[recipe.id];
      const input: Record<string, unknown> = { ...formDefaults(recipe, status?.options, settings.data?.items ?? [], stored).defaults, ...stored };
      // … minus what the form no longer has: a draft outlives a workflow whose settings were changed since
      const has = new Set(recipe.inputs.map((i) => i.id));
      for (const id of Object.keys(input)) if (input[id] === undefined || !has.has(id)) delete input[id];
      const missing = recipe.inputs.find((i) => i.type === "image" && !i.optional && !input[i.id]);
      if (missing) throw new ApiError(`Choose the ${missing.label.toLowerCase()} first.`);
      // a prompt shown as an example is not a prompt: nothing is made from somebody else's text by accident
      const unwritten = recipe.inputs.find((i) => i.type === "prompt" && i.example && !String(input[i.id] ?? "").trim());
      if (unwritten) throw new ApiError(`Write the ${unwritten.label.toLowerCase()} first.`);
      await api.enqueue(recipe.id, input, count, draft.look);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["queue"] }),
  });

  const noun = recipe?.output === "image" ? "picture" : recipe?.output === "video" ? "video" : "sound";
  // pictures or videos: the models of the other kind are out of the way; the last one used of each kind is remembered
  const kinds = [...new Set(all.map((r) => r.output))];
  const [lastOf, setLastOf] = useState<Record<string, string>>({});
  // a model first, then what to do with it: the models that make this kind of thing, each with its operations
  const groups = useMemo(() => modelGroups(all.filter((r) => r.output === (recipe?.output ?? "image")), recipes.data?.families ?? []), [all, recipe?.output, recipes.data?.families]);
  const group = groups.find((g) => g.recipes.some((r) => r.id === recipe?.id));
  const why = (r: RecipeInfo) => (setup.isSuccess ? notReady(setup.data.recipes.find((x) => x.id === r.id), comfyOnline) : null);
  /** The operation last used with each model: going back to a model goes back to it. */
  const [lastIn, setLastIn] = useState<Record<string, string>>({});
  const pick = (id: string) => {
    const r = all.find((x) => x.id === id);
    if (!r) return;
    setLastOf((l) => ({ ...l, [r.output]: id }));
    const to = groups.find((g) => g.recipes.includes(r));
    if (to) setLastIn((l) => ({ ...l, [to.key]: id }));
    // another operation of the same model takes along what was set: the prompt, the model, the LoRAs, how it samples
    const carried = recipe && draft && to && to === group ? carryOver(recipe, r, draft.forms[recipe.id], draft.forms[r.id]) : {};
    d.setRecipe(id, carried);
  };
  const pickModel = (key: string) => {
    const to = groups.find((g) => g.key === key);
    if (!to) return;
    const back = to.recipes.find((r) => r.id === lastIn[key]);
    pick((back ?? to.recipes.find((r) => !why(r)) ?? to.recipes[0]!).id);
  };
  // a preset is a whole setup, kept under a name: the model, its form, who is in it
  const entities = useEntities();
  const presets = (entities.data?.items ?? []).filter((e) => e.kind === "preset");
  const [presetName, setPresetName] = useState("");
  // a draft being given a name of its own, instead of the start of what is written in it
  const [naming, setNaming] = useState<{ id: string; text: string } | null>(null);
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.saveDraft(v.id, { name: v.name }),
    onSettled: () => {
      setNaming(null);
      return client.invalidateQueries({ queryKey: ["drafts"], exact: true });
    },
  });
  const [designing, setDesigning] = useState(false);
  const mainText = recipe?.inputs.find((i) => i.type === "prompt" && !i.optional) ?? recipe?.inputs.find((i) => i.type === "prompt");
  const savePreset = useMutation({
    mutationFn: (name: string) => api.createEntity("preset", name, { recipe: recipe!.id, inputs: draft!.forms[recipe!.id] ?? {}, look: draft!.look }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["entities"] }),
  });
  const estimates = useEstimates();
  const whole = recipe && draft ? { ...formDefaults(recipe, status?.options, settings.data?.items ?? [], draft.forms[recipe.id]).defaults, ...draft.forms[recipe.id] } : {};
  const each = estimateFor(estimates.data?.rates, recipe, whole);
  const items = latest.data?.pages[0]?.items ?? [];
  const waiting = queue.data?.waiting.length ?? 0;

  return (
    <div className="flex min-h-0 min-w-0 grow">
      <section className="flex w-[408px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex min-h-0 grow flex-col gap-3.5 overflow-y-auto p-4">
          <div className="flex flex-col gap-1.5">
            {kinds.length > 1 && recipe && (
              <Segmented
                label="What to make"
                value={recipe.output}
                options={kinds.map((k) => ({ value: k, label: k === "image" ? "Picture" : k === "video" ? "Video" : "Sound" }))}
                onChange={(k) => pick(lastOf[k] ?? all.find((r) => r.output === k)!.id)}
              />
            )}
            {group && recipe && (
              <>
                <div className="flex items-center gap-2.5">
                  <label htmlFor="create-model" className="w-16 shrink-0 text-xs font-semibold">Model</label>
                  <Select
                    id="create-model"
                    label="Model"
                    searchHint="Search your models and workflows"
                    className="min-w-0 grow"
                    value={group.key}
                    onChange={pickModel}
                    options={groups.map((g) => ({
                      value: g.key, label: g.name, group: g.builtIn ? "Models" : "Only from your workflows",
                      note: g.recipes.some((r) => !why(r)) ? `${g.recipes.length} operation${g.recipes.length === 1 ? "" : "s"}` : "not ready",
                      detail: g.builtIn ? g.summary : g.recipes.map((r) => r.title).join(" · "), search: g.recipes.map((r) => r.title).join(" "),
                    }))}
                  />
                </div>
                {/* its operations: what is built in, then your workflows for it. A few are tabs; many go in a list */}
                {group.recipes.length > 1 && group.recipes.length <= 8 && (
                  <div role="radiogroup" aria-label="Operation" className="flex flex-wrap gap-1 rounded-[9px] bg-raised p-[3px]">
                    {group.recipes.map((r) => {
                      const on = r.id === recipe.id;
                      const own = r.id.startsWith("workflow.");
                      return (
                        <button
                          key={r.id}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          title={`${why(r) ? `${why(r)} ` : ""}${r.summary}`}
                          onClick={() => pick(r.id)}
                          className={cx("flex h-7 min-w-0 grow items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-semibold", own ? "basis-[45%]" : "basis-[30%]", on ? "bg-line-strong text-white" : why(r) ? "text-ink-3" : "text-ink-2 hover:text-ink")}
                        >
                          {own && <Workflow size={12} className="shrink-0" />}
                          <span className="truncate">{r.title}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {group.recipes.length > 8 && (
                  <div className="flex items-center gap-2.5">
                    <label htmlFor="create-operation" className="w-16 shrink-0 text-xs font-semibold">Operation</label>
                    <Select
                      id="create-operation"
                      label="Operation"
                      className="min-w-0 grow"
                      value={recipe.id}
                      onChange={pick}
                      options={group.recipes.map((r) => ({ value: r.id, label: r.title, detail: r.summary, note: why(r) ? "not ready" : undefined, group: r.id.startsWith("workflow.") ? "Your workflows" : "Built in" }))}
                    />
                  </div>
                )}
                <span className={cx("text-xs", why(recipe) ? "text-warn-ink" : "text-ink-2")}>{why(recipe) ?? (group.recipes.length > 1 ? recipe.summary : `${recipe.title}. ${recipe.summary}`)}</span>
              </>
            )}
            {recipes.isError && <ErrorNote>{recipes.error.message}</ErrorNote>}
          </div>
          {recipe && draft && (
            <>
              {/* people, places and styles are words, LoRAs and pictures to follow: a tool that takes none of them has no use for them */}
              {recipe.inputs.some((i) => i.type === "prompt" || i.type === "loras" || i.type === "references") && <LookBar look={draft.look} onChange={d.setLook} recipe={recipe} input={whole} />}
              <Select
                dashed
                size="sm"
                className="h-9"
                icon={<Bookmark size={13} className="shrink-0" />}
                label="Presets"
                placeholder={presets.length ? "Use a preset, or save this as one" : "Save all this as a preset"}
                value=""
                onChange={(id) => {
                  const p = presets.find((x) => x.id === id);
                  if (p?.kind === "preset") d.apply(p.def.recipe, p.def.inputs, p.def.look ?? null);
                }}
                options={presets.map((p) => ({ value: p.id, label: p.name, note: p.kind === "preset" ? recipeLabel(recipes.data?.families.find((f) => f.id === all.find((r) => r.id === p.def.recipe)?.family)?.name, all.find((r) => r.id === p.def.recipe)?.title ?? "a model that is gone") : "" }))}
                footer={(close) => (
                  <form
                    className="flex items-center gap-1.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!presetName.trim()) return;
                      savePreset.mutate(presetName.trim());
                      setPresetName("");
                      close();
                    }}
                  >
                    <input aria-label="Name of a new preset" placeholder="Save all this as: type a name" value={presetName} onChange={(e) => setPresetName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="h-8 min-w-0 grow rounded-md bg-raised px-2 placeholder:text-ink-3" />
                    <Button size="sm" tone="quiet" type="submit" disabled={!presetName.trim()}>Save</Button>
                  </form>
                )}
              />
              {savePreset.isError && <ErrorNote>{savePreset.error.message}</ErrorNote>}
              <WritingHelp
                recipe={recipe}
                text={mainText ? String(whole[mainText.id] ?? "") : ""}
                onDesigner={() => setDesigning(true)}
                onInsert={(snippet) => {
                  if (!mainText) return;
                  const now = String(whole[mainText.id] ?? "").trim();
                  d.setValue(recipe.id, mainText.id, now ? `${now}${mainText.type === "prompt" && mainText.style === "tags" ? ", " : " "}${snippet}` : snippet);
                }}
              />
            </>
          )}
          {recipe && draft && (
            <Form
              key={`${draft.id}:${recipe.id}`}
              recipe={recipe}
              status={status}
              stored={draft.forms[recipe.id]}
              onChange={(input, value) => d.setValue(recipe.id, input, value)}
              onClear={(inputs) => d.clearValues(recipe.id, inputs)}
            />
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-line p-4">
          {send.isError && <ErrorNote>{send.error.message}</ErrorNote>}
          {blocked && (
            <ErrorNote>
              {blocked} <Link href="/setup" className="font-semibold underline">Open Setup</Link>
            </ErrorNote>
          )}
          <div className="flex items-center gap-2.5">
            <div className="flex h-11 shrink-0 items-center rounded-lg border border-line">
              <button type="button" aria-label="One fewer" onClick={() => d.setCount(count - 1)} className="flex h-full w-9 items-center justify-center"><Minus size={14} /></button>
              <span className="w-6 text-center font-bold">{count}</span>
              <button type="button" aria-label="One more" onClick={() => d.setCount(count + 1)} className="flex h-full w-9 items-center justify-center"><Plus size={14} /></button>
            </div>
            <Button tone="primary" className="h-11 grow text-sm" disabled={!recipe || !draft || Boolean(blocked) || send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? "Sending…" : `Make ${count} ${noun}${count > 1 ? "s" : ""}${each ? ` · ${aboutMs(each * count)}` : ""}`}
            </Button>
          </div>
        </div>
      </section>

      <main className="flex min-w-0 grow flex-col">
        <header className="flex h-[60px] shrink-0 items-center gap-3 px-5">
          <h1 className="text-base font-semibold">New {noun}</h1>
          <span className={cx("rounded-full px-2.5 py-0.5 text-[11px]", d.saving === "failed" ? "bg-warn-wash text-warn-ink" : "bg-raised text-ink-2")}>
            {d.saving === "saved" ? "Draft saved" : d.saving === "saving" ? "Saving…" : "Could not save the draft"}
          </span>
          <span className="grow" />
          {waiting > 0 && <Link href="/queue" className="text-xs text-ink-2 underline">{waiting} waiting</Link>}
        </header>

        <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto px-5 whitespace-nowrap">
          <span className="text-xs font-semibold text-ink-2">Your drafts</span>
          {d.drafts.map((x) => {
            const on = x.id === draft?.id;
            // a name it was given; else the open draft shows what is on screen, before it is saved
            const main = recipe?.inputs.find((i) => i.type === "prompt")?.id ?? "prompt";
            const title = x.name || (on ? String(draft?.forms[draft.recipe]?.[main] ?? "").trim().slice(0, 60) : x.title) || "Empty draft";
            if (naming?.id === x.id) {
              return (
                <form
                  key={x.id}
                  className="flex h-8 shrink-0 items-center rounded-full border border-accent bg-accent-wash pr-1 pl-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    rename.mutate({ id: x.id, name: naming.text });
                  }}
                >
                  <input
                    autoFocus
                    aria-label="Name of the draft"
                    placeholder="A name (empty: what is written in it)"
                    value={naming.text}
                    maxLength={80}
                    onChange={(e) => setNaming({ id: x.id, text: e.target.value })}
                    onBlur={() => naming && rename.mutate({ id: x.id, name: naming.text })}
                    onKeyDown={(e) => {
                      if (e.key !== "Escape") return;
                      // leaving the field without keeping what was typed: it must not be saved by the blur that follows
                      e.currentTarget.onblur = null;
                      setNaming(null);
                    }}
                    className="h-6 w-56 bg-transparent text-xs font-semibold placeholder:font-normal placeholder:text-ink-3 focus:outline-none"
                  />
                </form>
              );
            }
            return (
              <span key={x.id} className={cx("flex h-8 shrink-0 items-center rounded-full border", on ? "border-accent bg-accent-wash" : "border-line bg-panel")}>
                <button type="button" aria-pressed={on} title="Double-click to rename" onClick={() => void d.switchTo(x.id)} onDoubleClick={() => setNaming({ id: x.id, text: x.name ?? "" })} className="flex h-full max-w-64 items-center gap-2 pr-1 pl-3 text-xs">
                  <span className={cx("truncate", on ? "font-semibold" : "text-ink")}>{title}</span>
                  {!on && <span className="shrink-0 text-ink-3">{when(x.updatedAt)}</span>}
                </button>
                {on && (
                  <button type="button" aria-label={`Rename the draft "${title}"`} title="Rename" onClick={() => setNaming({ id: x.id, text: x.name ?? "" })} className="flex h-6 w-6 items-center justify-center rounded-full text-ink-3 hover:bg-hover hover:text-ink">
                    <Pencil size={11} />
                  </button>
                )}
                <button type="button" aria-label={`Delete the draft "${title}"`} onClick={() => void d.remove(x.id)} className="mr-1 flex h-6 w-6 items-center justify-center rounded-full text-ink-3 hover:bg-hover hover:text-ink">
                  <X size={12} />
                </button>
              </span>
            );
          })}
          <button type="button" onClick={() => void d.startNew()} className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border-[1.5px] border-dashed border-line-strong px-3 text-xs font-semibold text-ink-2 hover:text-ink">
            <Plus size={12} strokeWidth={2.6} /> New draft
          </button>
        </div>

        <div className="min-h-0 grow overflow-y-auto px-5 pt-2 pb-6">
          {!queue.data?.running && !items.length && (
            <Empty title="Your results appear here">Write what you want on the left, then press Make.</Empty>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3.5">
            {queue.data?.running && <LiveTile job={queue.data.running} />}
            {items.map((a) => <Tile key={a.id} asset={a} onOpen={() => setOpen(a)} />)}
          </div>
        </div>
      </main>

      {designing && recipe && draft && (
        <Designer
          recipe={recipe}
          values={whole}
          look={draft.look}
          turns={draft.chat as DesignerTurn[]}
          onTurns={d.setChat}
          session={draft.designer}
          onSession={d.setDesigner}
          onApply={(changes) => d.setValues(recipe.id, changes)}
          onClose={() => setDesigning(false)}
        />
      )}
      {open && <Viewer asset={items.find((a) => a.id === open.id) ?? open} onClose={() => setOpen(null)} />}
    </div>
  );
}
