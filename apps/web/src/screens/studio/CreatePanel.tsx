import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bookmark, ChevronLeft, Minus, Pencil, Plus, Trash2, Workflow } from "lucide-react";
import { hasWildcards } from "@afflatus/core";
import { api, ApiError, type RecipeInfo, type Entity } from "../../api";
import { DRAFT_LIST, useEntities, useEstimates, useFamilies, useModelSettings, useQueue, useRecipes, useSetup } from "../../data";
import type { DesignerTurn } from "../../Designer";
import { WritingHelp } from "../../WritingHelp";
import { useDraft } from "../../draft";
import { estimateFor } from "../../estimate";
import { Form, mainTextOf } from "../../RecipeForm";
import { formDefaults, matchFiles } from "../../form";
import { takePreset } from "../../handoff";
import { aboutMs, notReady, recipeLabel, when } from "../../format";
import { LookBar, lookWords } from "../../LookBar";
import { FormModel, ResultsPlace } from "../../ModelLoad";
import { carryAcross, carryOver, modelGroups } from "../../picker";
import { appendTo } from "../../promptText";
import { Select } from "../../Select";
import { usePanelWidth } from "../../store";
import { Button, cx, ErrorNote, ScrollColumn, Segmented, PanelEdge } from "../../ui";

// the designer's panel is a chunk of its own: fetched the first time it opens
const Designer = lazy(() => import("../../Designer").then((m) => ({ default: m.Designer })));

/**
 * The form that makes things, as a panel: the draft it is on, then the form in its parts, then the
 * button. What it makes is filed in `folder`, the one that is open beside it.
 */
export function CreatePanel({ folder, onClose }: { folder: { id: string; name: string; path: string | null } | null; onClose(): void }) {
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
      if (missing) throw new ApiError(`Select the ${missing.label.toLowerCase()} first.`);
      // a prompt shown as an example is not a prompt: nothing is made from somebody else's text by accident
      const unwritten = recipe.inputs.find((i) => i.type === "prompt" && i.example && !String(input[i.id] ?? "").trim());
      if (unwritten) throw new ApiError(`Fill in the ${unwritten.label.toLowerCase()} first.`);
      await api.enqueue(recipe.id, input, count, draft.look, { draft: draft.id, folder: folder?.id });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["queue"] }),
  });

  // Ctrl + Enter makes it, from anywhere on the screen, a text box included
  const make = useRef(() => {});
  make.current = () => {
    if (recipe && draft && !blocked && !send.isPending && !document.querySelector("[role=dialog][aria-modal=true]")) send.mutate();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        make.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const noun = recipe?.output === "image" ? "image" : recipe?.output === "video" ? "video" : "audio clip";
  // pictures or videos: the models of the other kind are out of the way; the last one used of each kind is remembered
  const kinds = [...new Set(all.map((r) => r.output))];
  const [lastOf, setLastOf] = useState<Record<string, string>>({});
  // a model first, then what to do with it: the models that make this kind of thing, each with its operations
  const groups = useMemo(
    () => modelGroups(all.filter((r) => r.output === (recipe?.output ?? "image") && (families.isOn(r.family) || r.id === recipe?.id)), recipes.data?.families ?? []),
    [all, recipe?.output, recipe?.id, recipes.data?.families, families],
  );
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
    // another operation of the same model takes along what was set: the prompt, the model, the LoRAs, how it samples.
    // Another model that makes the same kind of thing takes along what it is made from and about: the pictures
    // (a start image stays the start image) and what is written, never the settings of the first model
    const carried = !recipe || !draft || !to ? {}
      : to === group ? carryOver(recipe, r, draft.forms[recipe.id], draft.forms[r.id])
      : r.output === recipe.output ? carryAcross(recipe, r, draft.forms[recipe.id], draft.forms[r.id])
      : {};
    d.setRecipe(id, carried);
  };
  const pickModel = (key: string) => {
    const to = groups.find((g) => g.key === key);
    if (!to) return;
    const back = to.recipes.find((r) => r.id === lastIn[key]);
    pick((back ?? to.recipes.find((r) => !why(r)) ?? to.recipes[0]!).id);
  };
  // a preset is a whole setup, kept under a name: the model, its form, who is in it
  const presets = (entities.data?.items ?? []).filter((e) => e.kind === "preset");
  const applyPreset = (p: Extract<Entity, { kind: "preset" }>) => {
    const r = p.def.recipe ? all.find((x) => x.id === p.def.recipe) : undefined;
    d.apply(p.def.recipe, r ? matchFiles(r, setup.data?.recipes.find((x) => x.id === r.id)?.options, p.def.inputs) : p.def.inputs, p.def.look ?? null);
  };
  // "Apply in Studio" on the Prompt kit: the preset it handed over, once the draft and the presets are here
  useEffect(() => {
    if (!draft || !entities.data) return;
    const id = takePreset();
    const p = id ? presets.find((x) => x.id === id) : undefined;
    if (p?.kind === "preset") applyPreset(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, entities.data]);
  const [presetName, setPresetName] = useState("");
  // a draft being given a name of its own, instead of the start of what is written in it
  const [naming, setNaming] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.saveDraft(v.id, { name: v.name }),
    onSettled: () => {
      setNaming(null);
      return client.invalidateQueries({ queryKey: DRAFT_LIST });
    },
  });
  // Escape leaves the name box without keeping what was typed: the blur that follows must not save it
  const cancelledNaming = useRef(false);
  const [designing, setDesigning] = useState(false);
  const mainText = recipe ? mainTextOf(recipe) : undefined;
  const savePreset = useMutation({
    mutationFn: (name: string) => api.createEntity("preset", name, { recipe: recipe!.id, inputs: draft!.forms[recipe!.id] ?? {}, look: draft!.look }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["entities"] }),
  });
  const estimates = useEstimates();
  const loadedNow = useQueue().data?.model ?? null;
  const whole = recipe && draft ? { ...formDefaults(recipe, status?.options, settings.data?.items ?? [], draft.forms[recipe.id]).defaults, ...draft.forms[recipe.id] } : {};
  const each = estimateFor(estimates.data, recipe, whole, loadedNow);
  const titleOf = (x: { id: string; name: string | null; title: string }) =>
    x.name || (x.id === draft?.id && mainText ? String(draft.forms[draft.recipe]?.[mainText.id] ?? "").trim().slice(0, 60) : x.title) || "No prompt yet";

  const made = group && recipe && (
    <>
      <div className="flex items-center gap-2">
        {kinds.length > 1 && (
          <Segmented
            label="Output type"
            value={recipe.output}
            options={kinds.map((k) => ({ value: k, label: k === "image" ? "Image" : k === "video" ? "Video" : "Audio" }))}
            onChange={(k) => pick(lastOf[k] ?? all.find((r) => r.output === k)!.id)}
          />
        )}
        <Select
          id="create-model"
          label="Model"
          searchHint="Search your models and workflows"
          className="min-w-0 grow"
          value={group.key}
          onChange={pickModel}
          options={groups.map((g) => ({
            value: g.key, label: g.name, group: g.builtIn ? "Models" : "Your workflows",
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
                className={cx("flex h-7 min-w-0 grow items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-semibold", own ? "basis-[45%]" : "basis-[30%]", on ? "bg-line-strong text-ink-strong" : why(r) ? "text-ink-3" : "text-ink-2 hover:text-ink")}
              >
                {own && <Workflow size={12} className="shrink-0" />}
                <span className="truncate">{r.title}</span>
              </button>
            );
          })}
        </div>
      )}
      {group.recipes.length > 8 && (
        <Select
          id="create-operation"
          label="Operation"
          value={recipe.id}
          onChange={pick}
          options={group.recipes.map((r) => ({ value: r.id, label: r.title, detail: r.summary, note: why(r) ? "not ready" : undefined, group: r.id.startsWith("workflow.") ? "Your workflows" : "Built in" }))}
        />
      )}
      <span className={cx("text-xs", why(recipe) ? "text-warn-ink" : "text-ink-2")}>{why(recipe) ?? (group.recipes.length > 1 ? recipe.summary : `${recipe.title}. ${recipe.summary}`)}</span>
      <Select
        dashed
        size="sm"
        className="h-9"
        icon={<Bookmark size={13} className="shrink-0" />}
        label="Presets"
        placeholder={presets.length ? "Load a preset, or save this as one" : "Save as preset"}
        value=""
        onChange={(id) => {
          const p = presets.find((x) => x.id === id);
          if (p?.kind === "preset") applyPreset(p);
        }}
        options={presets.map((p) => ({ value: p.id, label: p.name, note: p.kind === "preset" ? (p.def.recipe ? recipeLabel(recipes.data?.families.find((f) => f.id === all.find((r) => r.id === p.def.recipe)?.family)?.name, all.find((r) => r.id === p.def.recipe)?.title ?? "model no longer installed") : "any model") : "" }))}
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
            <input aria-label="New preset name" placeholder="Save as preset: name" value={presetName} onChange={(e) => setPresetName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="h-8 min-w-0 grow rounded-md bg-raised px-2 placeholder:text-ink-3" />
            <Button size="sm" tone="quiet" type="submit" disabled={!presetName.trim()}>Save</Button>
          </form>
        )}
      />
      {savePreset.isError && <ErrorNote>{savePreset.error.message}</ErrorNote>}
    </>
  );
  const takesLook = recipe?.inputs.some((i) => i.type === "prompt" || i.type === "loras" || i.type === "references");

  const panelWidth = usePanelWidth((s) => s.width);
  return (
    <aside aria-label="Create" data-designer-stays style={{ width: panelWidth }} className="relative flex shrink-0 flex-col border-r border-line bg-panel">
      <PanelEdge side="right" />
      <div className="flex h-[60px] shrink-0 items-center gap-1.5 border-b border-line px-3">
        {naming !== null && draft ? (
          <form
            className="flex min-w-0 grow"
            onSubmit={(e) => {
              e.preventDefault();
              rename.mutate({ id: draft.id, name: naming });
            }}
          >
            <input
              autoFocus
              aria-label="Draft name"
              placeholder="Draft name (empty: the start of the prompt)"
              value={naming}
              maxLength={80}
              onChange={(e) => setNaming(e.target.value)}
              onBlur={() => {
                if (cancelledNaming.current) {
                  cancelledNaming.current = false;
                  return;
                }
                if (naming !== null) rename.mutate({ id: draft.id, name: naming });
              }}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                cancelledNaming.current = true;
                setNaming(null);
              }}
              className="h-9 min-w-0 grow rounded-lg border border-accent bg-raised px-2.5 font-semibold placeholder:font-normal placeholder:text-ink-3"
            />
          </form>
        ) : (
          <div className="min-w-0 grow">
            <Select
              label="Drafts"
              searchHint="Search drafts"
              className="h-9 font-semibold"
              value={draft?.id ?? ""}
              onChange={(id) => void d.switchTo(id)}
              options={d.drafts.map((x) => ({ value: x.id, label: titleOf(x), note: x.id === draft?.id ? "open" : when(x.updatedAt) }))}
              placeholder="No draft yet"
            />
          </div>
        )}
        <button type="button" aria-label="Rename this draft" title="Rename this draft" disabled={!draft} onClick={() => { cancelledNaming.current = false; setNaming(draft?.name ?? ""); }} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><Pencil size={13} /></button>
        <button type="button" aria-label="Delete this draft" title="Delete this draft. Its outputs stay in your library." disabled={!draft} onClick={() => draft && void d.remove(draft.id)} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><Trash2 size={13} /></button>
        <button type="button" title="New draft: an empty form. This one is kept." onClick={() => void d.startNew()} className="flex h-9 shrink-0 items-center gap-1 rounded-lg border-[1.5px] border-dashed border-line-strong px-2.5 text-xs font-semibold text-ink-2 hover:text-ink"><Plus size={12} strokeWidth={2.6} /> New</button>
        <button type="button" aria-label="Close the form" title="Fold the form away: the library takes the whole width. N opens it again." onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/50 text-accent hover:bg-accent-wash"><ChevronLeft size={15} /></button>
      </div>

      <ScrollColumn className="flex flex-col gap-2.5 p-3">
        {recipes.isError && <ErrorNote>{recipes.error.message}</ErrorNote>}
        <span className={cx("flex items-center gap-2 px-1 text-xs", d.saving === "failed" ? "text-warn-ink" : "text-ink-3")}>
          {d.saving === "saved" ? "Draft saved" : d.saving === "saving" ? "Saving…" : "Could not save the draft: what is on screen is kept here until it is."}
          {d.saving === "failed" && <button type="button" onClick={d.retry} className="font-semibold underline underline-offset-2">Retry</button>}
        </span>
        {recipe && draft && (
          <Form
            key={`${draft.id}:${recipe.id}`}
            recipe={recipe}
            status={status}
            stored={draft.forms[recipe.id]}
            onChange={(input, value) => d.setValue(recipe.id, input, value)}
            onClear={(inputs) => d.clearValues(recipe.id, inputs)}
            made={made}
            madeSummary={group ? `${group.name} · ${recipe.title}` : recipe.title}
            look={takesLook ? <LookBar look={draft.look} onChange={d.setLook} recipe={recipe} input={whole} /> : undefined}
            lookSummary={takesLook ? lookWords(draft.look, entities.data?.items ?? []) : undefined}
            helpers={
              <WritingHelp
                recipe={recipe}
                text={mainText ? String(whole[mainText.id] ?? "") : ""}
                look={draft.look}
                onLook={d.setLook}
                onDesigner={() => setDesigning(true)}
                onInsert={(snippet) => {
                  if (mainText?.type === "prompt") d.setValue(recipe.id, mainText.id, appendTo(String(whole[mainText.id] ?? ""), snippet, mainText.style));
                }}
              />
            }
          />
        )}
      </ScrollColumn>

      <div className="flex shrink-0 flex-col gap-2 border-t border-line p-3">
        {send.isError && <ErrorNote>{send.error.message}</ErrorNote>}
        {blocked && (
          <ErrorNote>
            {blocked} <Link href="/settings/models" className="font-semibold underline">Open settings</Link>
          </ErrorNote>
        )}
        {recipe && recipe.inputs.some((i) => i.type === "prompt" && hasWildcards(String(whole[i.id] ?? ""))) && (
          <span className="text-xs text-ink-2">{"{a|b|c}"} wildcard: one option is picked for each {noun}{count === 1 ? ". Generate several to see them vary." : "."}</span>
        )}
        {recipe && draft && !blocked && <FormModel recipe={recipe} input={whole} look={draft.look} />}
        <ResultsPlace folder={folder ? { name: folder.name, path: folder.path } : null} />
        <div className="flex items-center gap-2.5">
          <div className="flex h-11 shrink-0 items-center rounded-lg border border-line">
            <button type="button" aria-label="Batch count: one fewer" onClick={() => d.setCount(count - 1)} className="flex h-full w-9 items-center justify-center"><Minus size={14} /></button>
            <span className="w-6 text-center font-bold">{count}</span>
            <button type="button" aria-label="Batch count: one more" onClick={() => d.setCount(count + 1)} className="flex h-full w-9 items-center justify-center"><Plus size={14} /></button>
          </div>
          <Button tone="primary" className="h-11 grow text-sm" disabled={!recipe || !draft || Boolean(blocked) || send.isPending} onClick={() => send.mutate()}>
            <span title="Ctrl + Enter">{send.isPending ? "Queuing…" : `Generate ${count} ${noun}${count > 1 ? "s" : ""}${each ? ` · ${aboutMs(each.ms * count + each.loadMs)}` : ""}`}</span>
          </Button>
        </div>
      </div>

      {designing && recipe && draft && (
        <Suspense fallback={null}>
          <Designer
            recipe={recipe}
            values={whole}
            look={draft.look}
            turns={draft.chat as DesignerTurn[]}
            onTurns={d.setChat}
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
}
