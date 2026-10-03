import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bookmark, ChevronDown, ChevronLeft, Film, Folder as FolderIcon, Minus, Pencil, Plus, Search, Square, Star, Trash2, Undo2, Workflow, X } from "lucide-react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { hasWildcards } from "@studai/core";
import { api, ApiError, thumbUrl, type Asset, type RecipeInfo, type RunningJob } from "../api";
import { askAboutDisk } from "../Confirm";
import { useAssetFamilies, useAssetModels, useAssets, useEntities, useEstimates, useFamilies, useFolders, useModelSettings, useQueue, useRecipes, useSetup, useTimelines } from "../data";
import { Designer, WritingHelp, type DesignerTurn } from "../Designer";
import { useDraft } from "../draft";
import { estimateFor } from "../estimate";
import { Form, mainTextOf } from "../RecipeForm";
import { formDefaults } from "../form";
import { about, aboutMs, clock, fileLabel, notReady, phaseLabel, recipeLabel, when } from "../format";
import { plainKey } from "../Keys";
import { LivePreview } from "../LivePreview";
import { LookBar, lookWords } from "../LookBar";
import { FormModel, ResultsPlace, useStop } from "../ModelLoad";
import { carryAcross, carryOver, modelGroups } from "../picker";
import { Popover } from "../Popover";
import { appendTo } from "../promptText";
import { Select } from "../Select";
import { useHandover, useOpenDraft, usePanelWidth } from "../store";
import { Bar, Button, cx, Empty, ErrorNote, ScrollColumn, Segmented, PanelEdge } from "../ui";
import { Viewer } from "../Viewer";
import { DRAG_TYPE, FolderPanel, Tile, type Place } from "./Library";

/**
 * Studio: the library, with the form that makes things as a panel that opens and closes on its left.
 * Closed, the library has the whole width. Open, what is made lands in the folder that is open, and
 * the right side shows either that folder or only what the draft in the form has made, its newest
 * result large.
 */

/** How the screen was left: kept from one visit to the next, and while another screen is open. */
const useStudio = create<{
  form: boolean;
  size: "S" | "M" | "L";
  scope: "draft" | "all";
  place: Place;
  set(patch: Partial<{ form: boolean; size: "S" | "M" | "L"; scope: "draft" | "all"; place: Place }>): void;
}>()(persist((set) => ({ form: false, size: "M", scope: "draft", place: { type: "all" }, set: (patch) => set(patch) }), { name: "studai.studio" }));

const KINDS = [
  { id: "all", label: "All", kind: undefined },
  { id: "image", label: "Images", kind: "image" },
  { id: "video", label: "Videos", kind: "video" },
  { id: "audio", label: "Audio", kind: "audio" },
  { id: "timeline", label: "Timelines", kind: undefined },
] as const;
const TILE = { S: "minmax(120px,1fr)", M: "minmax(170px,1fr)", L: "minmax(250px,1fr)" };

function LiveTile({ job, onClick, on, title }: { job: RunningJob; onClick?(): void; on?: boolean; title?: string }) {
  const stop = useStop();
  return (
    <div data-stage className={cx("relative aspect-[3/4] overflow-hidden rounded-[10px] border bg-panel", on ? "border-2 border-accent" : "border-line-strong")}>
      <button type="button" onClick={onClick} disabled={!onClick} aria-label={title ?? "Running job"} title={title} className="absolute inset-0 flex flex-col items-center justify-center gap-2">
        <LivePreview job={job} className="absolute inset-0 h-full w-full object-cover opacity-80" />
        <div className="relative flex w-full flex-col items-center gap-1.5 bg-ground/60 px-2 py-2 text-center">
          <div className="text-xs font-semibold">{phaseLabel(job.phase)}</div>
          <div className="w-4/5"><Bar value={job.progress * 100} /></div>
        </div>
      </button>
      <button
        type="button"
        aria-label="Cancel this render"
        title="Cancel this render. Nothing is saved."
        disabled={stop.isPending}
        onClick={() => stop.mutate([job.id])}
        className="absolute top-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-lg border border-line-strong bg-ground/80 text-ink hover:border-warn hover:text-warn"
      >
        <Square size={11} fill="currentColor" />
      </button>
    </div>
  );
}

/**
 * The form that makes things, as a panel: the draft it is on, then the form in its parts, then the
 * button. What it makes is filed in `folder`, the one that is open beside it.
 */
function CreatePanel({ folder, onClose }: { folder: { id: string; name: string; path: string | null } | null; onClose(): void }) {
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
  const [presetName, setPresetName] = useState("");
  // a draft being given a name of its own, instead of the start of what is written in it
  const [naming, setNaming] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.saveDraft(v.id, { name: v.name }),
    onSettled: () => {
      setNaming(null);
      return client.invalidateQueries({ queryKey: ["drafts"], exact: true });
    },
  });
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
          if (p?.kind === "preset") d.apply(p.def.recipe, p.def.inputs, p.def.look ?? null);
        }}
        options={presets.map((p) => ({ value: p.id, label: p.name, note: p.kind === "preset" ? recipeLabel(recipes.data?.families.find((f) => f.id === all.find((r) => r.id === p.def.recipe)?.family)?.name, all.find((r) => r.id === p.def.recipe)?.title ?? "model no longer installed") : "" }))}
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
              onBlur={() => naming !== null && rename.mutate({ id: draft.id, name: naming })}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                // leaving the field without keeping what was typed: it must not be saved by the blur that follows
                e.currentTarget.onblur = null;
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
        <button type="button" aria-label="Rename this draft" title="Rename this draft" disabled={!draft} onClick={() => setNaming(draft?.name ?? "")} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><Pencil size={13} /></button>
        <button type="button" aria-label="Delete this draft" title="Delete this draft. Its outputs stay in your library." disabled={!draft} onClick={() => draft && void d.remove(draft.id)} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><Trash2 size={13} /></button>
        <button type="button" title="New draft: an empty form. This one is kept." onClick={() => void d.startNew()} className="flex h-9 shrink-0 items-center gap-1 rounded-lg border-[1.5px] border-dashed border-line-strong px-2.5 text-xs font-semibold text-ink-2 hover:text-ink"><Plus size={12} strokeWidth={2.6} /> New</button>
        <button type="button" aria-label="Close the form" title="Close the form: the library takes the whole width" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/50 text-accent hover:bg-accent-wash"><ChevronLeft size={15} /></button>
      </div>

      <ScrollColumn className="flex flex-col gap-2.5 p-3">
        {recipes.isError && <ErrorNote>{recipes.error.message}</ErrorNote>}
        <span className={cx("px-1 text-xs", d.saving === "failed" ? "text-warn-ink" : "text-ink-3")}>{d.saving === "saved" ? "Draft saved" : d.saving === "saving" ? "Saving…" : "Could not save the draft"}</span>
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
            {blocked} <Link href="/settings" className="font-semibold underline">Open settings</Link>
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
    </aside>
  );
}

/**
 * What the draft in the form has made: the newest result large, with what can be done with it under
 * it, and the earlier ones as a strip to go back to. While the draft renders, what is forming is shown
 * large instead, until one of the results is picked.
 */
function DraftResults({ draft, folder }: { draft: string; folder: string | undefined }) {
  const assets = useAssets({ draft });
  const queue = useQueue();
  const items = assets.data?.pages.flatMap((p) => p.items) ?? [];
  const running = queue.data?.running?.draftId === draft ? queue.data.running : null;
  const inLine = (queue.data?.waiting ?? []).filter((j) => j.draftId === draft);
  const waiting = inLine.length;
  const stop = useStop();
  // what is shown large: the one that was picked, else what is forming, else the newest
  const [picked, setPicked] = useState<string | "live" | null>(null);
  const [details, setDetails] = useState<Asset | null>(null);
  // a new result takes the large place: the pick is forgotten when the list gets a new first item
  const newest = items[0]?.id;
  useEffect(() => setPicked(null), [newest, draft]);
  const chosen = picked && picked !== "live" ? items.find((a) => a.id === picked) : undefined;
  const live = running && (picked === "live" || !chosen);
  const shown = chosen ?? (live ? undefined : items[0]);

  if (assets.isSuccess && !items.length && !running && !waiting) {
    return <Empty title="No output from this draft yet">Write a prompt in the form and press Generate. This draft's outputs show here, the newest one large. "Whole folder" shows everything in the folder.</Empty>;
  }
  return (
    <div className="flex h-full min-h-0 gap-4">
      <div data-stage className="flex min-h-0 min-w-0 grow flex-col rounded-xl bg-ground p-[var(--stage-pad)]">
        {live && running && (
          <div className="flex min-h-0 grow flex-col items-center justify-center gap-3 pb-4">
            <LivePreview job={running} sound className="h-[calc(100%-70px)] min-h-0 w-auto max-w-full rounded-lg object-contain" />
            <div className="flex w-72 flex-col items-center gap-1.5 text-center">
              <span className="font-semibold">{phaseLabel(running.phase)}{running.steps ? ` · step ${running.step} of ${running.steps}` : ""}{running.eta ? ` · ${about(running.eta)}` : ""}</span>
              <div className="w-full"><Bar value={running.progress * 100} /></div>
              {waiting > 0 && <span className="text-xs text-ink-2">{waiting} more queued</span>}
              <div className="flex flex-wrap justify-center gap-2 pt-1">
                <Button size="sm" onClick={() => stop.mutate([running.id])} disabled={stop.isPending} title={waiting ? "Cancel this render. Nothing is saved; the next queued job starts." : "Cancel this render. Nothing is saved."}>
                  <Square size={11} fill="currentColor" /> Cancel render
                </Button>
                {waiting > 0 && (
                  <Button size="sm" onClick={() => stop.mutate([...inLine.map((j) => j.id), running.id])} disabled={stop.isPending} title="Cancel this render and remove the queued jobs from the queue.">
                    Cancel all {waiting + 1}
                  </Button>
                )}
              </div>
              {stop.isError && <ErrorNote>{stop.error.message}</ErrorNote>}
            </div>
          </div>
        )}
        {!live && shown && (
          <Viewer
            inline
            asset={shown}
            items={items}
            onOpen={(a) => setPicked(a.id)}
            onClose={() => {}}
            onDetails={() => setDetails(shown)}
            into={{ draft, folder }}
          />
        )}
      </div>
      <div className="flex w-[140px] shrink-0 flex-col gap-2.5 overflow-y-auto px-1 pb-4">
        <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">This draft · {items.length}</span>
        {running && <LiveTile job={running} on={Boolean(live)} onClick={() => setPicked("live")} />}
        {waiting > 0 && (
          <span className="flex items-center justify-between gap-1 rounded-lg border border-dashed border-line-strong py-1 pr-1 pl-2 text-xs text-ink-2">
            {waiting} queued
            <button type="button" aria-label={`Remove the ${waiting} queued jobs from the queue`} title="Remove from the queue" disabled={stop.isPending} onClick={() => stop.mutate(inLine.map((j) => j.id))} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-warn">
              <X size={13} />
            </button>
          </span>
        )}
        {items.map((a) => (
          <div key={a.id} className={cx("rounded-[12px] border-2", !live && shown?.id === a.id ? "border-accent" : "border-transparent")}>
            <Tile asset={a} onOpen={() => setPicked(a.id)} />
          </div>
        ))}
        {assets.hasNextPage && <Button size="sm" onClick={() => assets.fetchNextPage()} disabled={assets.isFetchingNextPage}>More</Button>}
      </div>
      {details && <Viewer asset={items.find((a) => a.id === details.id) ?? details} items={items} onOpen={setDetails} onClose={() => setDetails(null)} into={{ draft, folder }} />}
    </div>
  );
}

export function Studio({ open: forced }: { open?: boolean }) {
  const view = useStudio();
  const [, go] = useLocation();
  // "/create" (a link from elsewhere, a key in the viewer) opens the form; the screen itself lives at "/"
  useEffect(() => {
    if (!forced) return;
    view.set({ form: true });
    go("/", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forced]);

  const folders = useFolders();
  const place = view.place;
  // a folder that is gone is no place to be
  useEffect(() => {
    if (place.type === "folder" && folders.isSuccess && !folders.data.items.some((f) => f.id === place.id)) view.set({ place: { type: "all" } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, folders.data]);
  const folder = place.type === "folder" ? folders.data?.items.find((f) => f.id === place.id) : undefined;
  const placeName = place.type === "bin" ? "Bin" : place.type === "unfiled" ? "No folder" : place.type === "folder" ? folder?.name ?? "Folder" : "All";

  const draftId = useOpenDraft((s) => s.id);
  const openDraft = useOpenDraft((s) => s.open);
  const draftOnly = view.form && view.scope === "draft" && Boolean(draftId);

  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("all");
  const [open, setOpen] = useState<Asset | null>(null);
  // an item just dropped on the app: opened large, with everything that can be done with it
  const shown = useHandover((h) => h.show);
  const hand = useHandover((h) => h.set);
  useEffect(() => {
    if (!shown) return;
    hand({ show: null });
    void api.asset(shown).then((a) => setOpen(a)).catch(() => {});
  }, [shown, hand]);
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  // made with: a model family ("f:sdxl"), or one model file ("m:<file>"); and with one LoRA
  const [made, setMade] = useState("");
  const [lora, setLora] = useState("");
  const family = made.startsWith("f:") ? made.slice(2) : "";
  const model = made.startsWith("m:") ? made.slice(2) : "";
  const [kept, setKept] = useState(false);
  // what is typed is looked for once the typing stops
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed), 250);
    return () => clearTimeout(timer);
  }, [typed]);
  const showTimelines = kind === "timeline" && place.type !== "bin";
  const assets = useAssets({
    kind: KINDS.find((k) => k.id === kind)!.kind,
    bin: place.type === "bin" || undefined,
    folder: place.type === "folder" ? place.id : place.type === "unfiled" ? "none" : undefined,
    q: q || undefined,
    family: family || undefined,
    model: model || undefined,
    lora: lora || undefined,
    kept: kept || undefined,
  });
  const usedModels = useAssetModels();
  const items = showTimelines ? [] : assets.data?.pages.flatMap((p) => p.items) ?? [];
  const timelines = useTimelines();
  const families = useAssetFamilies();
  const recipes = useRecipes();
  const queue = useQueue();
  const familyName = (id: string) => recipes.data?.families.find((f) => f.id === id)?.name ?? id;
  const filtered = Boolean(q || made || lora || kept);

  // the folders: a panel under their button, which also opens by itself while something is dragged, to drop it on a folder
  const folderButton = useRef<HTMLButtonElement>(null);
  const [foldersOpen, setFoldersOpen] = useState<false | "click" | "drag">(false);
  useEffect(() => {
    const start = (e: DragEvent) => e.dataTransfer?.types.includes(DRAG_TYPE) && setFoldersOpen((o) => o || "drag");
    const end = () => setFoldersOpen((o) => (o === "drag" ? false : o));
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
    };
  }, []);
  const running = queue.data?.running ?? null;

  // ---- several items ticked, to move, keep or delete them together
  const client = useQueryClient();
  const [picked, setPicked] = useState<string[]>([]);
  const lastPicked = useRef<string | null>(null);
  const tick = (a: Asset, range: boolean) => {
    const from = range && lastPicked.current ? items.findIndex((x) => x.id === lastPicked.current) : -1;
    const to = items.findIndex((x) => x.id === a.id);
    if (from >= 0 && to >= 0) {
      // with Shift: everything from the last one ticked to this one
      const between = items.slice(Math.min(from, to), Math.max(from, to) + 1).map((x) => x.id);
      setPicked((old) => [...new Set([...old, ...between])]);
    } else setPicked((old) => (old.includes(a.id) ? old.filter((x) => x !== a.id) : [...old, a.id]));
    lastPicked.current = a.id;
  };
  // what is ticked is of the list that is shown: another folder, another search, and nothing is
  const listKey = JSON.stringify([place, kind, q, made, lora, kept, draftOnly]);
  useEffect(() => setPicked([]), [listKey]);
  const afterBulk = () => {
    setPicked([]);
    return client.invalidateQueries({ queryKey: ["assets"] });
  };
  const bulk = useMutation({ mutationFn: (action: "keep" | "unkeep" | "bin" | "restore") => api.bulkAssets(picked, action), onSuccess: afterBulk });
  const moveTo = useMutation({ mutationFn: (to: string | null) => api.moveAssets(picked, to), onSuccess: afterBulk });
  const chosen = items.filter((a) => picked.includes(a.id));
  /** The ticked items to the bin; files of a linked folder leave the disk, which is asked first. */
  const binChosen = async () => {
    if (await askAboutDisk(chosen)) bulk.mutate("bin");
  };
  // Esc unticks, Ctrl + A ticks everything shown, Del sends what is ticked to the bin
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (draftOnly || open || document.querySelector("[role=dialog][aria-modal=true]")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !(e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]") && items.length) {
      e.preventDefault();
      setPicked(items.map((a) => a.id));
      return;
    }
    if (!picked.length || !plainKey(e)) return;
    if (e.key === "Escape") setPicked([]);
    else if (e.key === "Delete" && place.type !== "bin") void binChosen();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const folderOptions = useMemo(() => {
    const all = folders.data?.items ?? [];
    const out: Array<{ value: string; label: string }> = [];
    const walk = (parent: string | null, depth: number) => {
      for (const f of all.filter((x) => x.parentId === parent)) {
        out.push({ value: f.id, label: `${"\u2003".repeat(depth)}${depth ? "\u21b3 " : ""}${f.name}` });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [folders.data]);

  return (
    <div className="flex min-h-0 min-w-0 grow">
      {view.form && <CreatePanel folder={folder ? { id: folder.id, name: folder.name, path: folder.path } : null} onClose={() => view.set({ form: false })} />}
      <div className="flex min-w-0 grow flex-col">
        <header className="flex h-[60px] shrink-0 items-center gap-2 px-5">
          <h1 className="sr-only">Studio</h1>
          <button
            ref={folderButton}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={Boolean(foldersOpen)}
            title="Folders, the bin, and items in no folder"
            onClick={() => setFoldersOpen(foldersOpen ? false : "click")}
            className={cx("flex h-9 max-w-64 shrink-0 items-center gap-2 rounded-lg border bg-raised px-3 text-sm font-semibold", foldersOpen ? "border-accent" : "border-line-strong")}
          >
            {place.type === "bin" ? <Trash2 size={15} className="shrink-0" /> : <FolderIcon size={15} className="shrink-0" />}
            <span className="truncate">{placeName}</span>
            <ChevronDown size={14} className="shrink-0 text-ink-2" />
          </button>
          {view.form && draftId && (
            <Segmented
              label="Results shown"
              value={view.scope}
              options={[{ value: "draft", label: "This draft" }, { value: "all", label: "Whole folder" }]}
              onChange={(scope) => view.set({ scope })}
            />
          )}
          {!draftOnly && KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
              className={cx("h-[30px] shrink-0 rounded-full border px-3 text-xs font-semibold", kind === k.id ? "border-ink bg-ink text-ground" : "border-line text-ink-2 hover:text-ink", view.form && "max-[1700px]:hidden")}
            >
              {k.label}
            </button>
          ))}
          <span className="grow" />
          {!draftOnly && picked.length > 0 && (
            <div className="flex shrink-0 items-center gap-2 rounded-lg border border-accent bg-panel py-1 pr-1 pl-3">
              <span className="font-semibold whitespace-nowrap">{picked.length} selected</span>
              {picked.length < items.length && <button type="button" onClick={() => setPicked(items.map((a) => a.id))} className="text-xs text-ink-2 underline hover:text-ink">select all {items.length}</button>}
              {place.type === "bin" ? (
                <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate("restore")}><Undo2 size={13} /> Restore</Button>
              ) : (
                <>
                  <div className="w-44">
                    <Select
                      size="sm" label="Move the selected items to a folder" placeholder="Move to folder" searchHint="Search folders" value=""
                      onChange={(to) => moveTo.mutate(to === "__none__" ? null : to)}
                      options={[...folderOptions, { value: "__none__", label: "No folder" }]}
                    />
                  </div>
                  {chosen.some((a) => !a.kept) && <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate("keep")}><Star size={13} /> Keep</Button>}
                  {chosen.length > 0 && chosen.every((a) => a.kept) && <Button size="sm" disabled={bulk.isPending} title="They go back on the one-day countdown" onClick={() => bulk.mutate("unkeep")}>Unkeep</Button>}
                  <Button size="sm" disabled={bulk.isPending} title="To the bin, where they wait a week (Del)" onClick={() => void binChosen()}><Trash2 size={13} /> Bin</Button>
                </>
              )}
              <button type="button" aria-label="Clear selection" title="Clear selection (Esc)" onClick={() => setPicked([])} className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"><X size={14} /></button>
            </div>
          )}
          {!draftOnly && picked.length === 0 && (
            <>
              <label className="flex h-9 w-64 min-w-28 shrink items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent">
                <Search size={14} className="shrink-0 text-ink-3" />
                <input data-search aria-label="Search the library" placeholder="Search prompts and names" value={typed} onChange={(e) => setTyped(e.target.value)} className="min-w-0 grow bg-transparent placeholder:text-ink-3 focus:outline-none" />
                {typed && <button type="button" aria-label="Clear the search" onClick={() => setTyped("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
              </label>
              {!view.form && (families.data?.items.length ?? 0) > 0 && (
                <div className="w-40 shrink-0">
                  <Select
                    size="sm" className={cx("h-9", made && "border-accent")} label="Filter by model" searchHint="Search models used in the library" value={made} onChange={setMade}
                    options={[
                      { value: "", label: "Any model" },
                      ...families.data!.items.map((f) => ({ value: `f:${f}`, label: familyName(f), group: "Model family" })),
                      ...(usedModels.data?.models ?? []).map((m) => ({ value: `m:${m.file}`, label: fileLabel(m.file), note: String(m.count), search: m.file, group: "Checkpoint or model file" })),
                    ]}
                  />
                </div>
              )}
              {!view.form && (usedModels.data?.loras.length ?? 0) > 0 && (
                <div className="w-36 shrink-0">
                  <Select
                    size="sm" className={cx("h-9", lora && "border-accent")} label="Filter by LoRA" searchHint="Search LoRAs used in the library" value={lora} onChange={setLora}
                    options={[{ value: "", label: "Any LoRA" }, ...usedModels.data!.loras.map((l) => ({ value: l.file, label: fileLabel(l.file), note: String(l.count), search: l.file }))]}
                  />
                </div>
              )}
              <button type="button" aria-pressed={kept} onClick={() => setKept(!kept)} className={cx("flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold", kept ? "border-accent text-accent" : "border-line text-ink-2 hover:text-ink")}>
                <Star size={13} fill={kept ? "currentColor" : "none"} /> Kept only
              </button>
              <Segmented label="Thumbnail size" value={view.size} options={[{ value: "S", label: "S" }, { value: "M", label: "M" }, { value: "L", label: "L" }]} onChange={(size) => view.set({ size })} />
            </>
          )}
          {!view.form && (
            <button type="button" onClick={() => view.set({ form: true })} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-accent px-4 font-bold text-accent-ink">
              <Plus size={15} strokeWidth={2.6} /> Create
            </button>
          )}
        </header>

        <div className={cx("min-h-0 grow px-5 pt-1.5", draftOnly ? "overflow-hidden" : "overflow-y-auto pb-6")}>
          {draftOnly ? (
            <DraftResults draft={draftId!} folder={folder?.id} />
          ) : (
            <>
              {assets.isError && <ErrorNote>{assets.error.message}</ErrorNote>}
              {(bulk.isError || moveTo.isError) && <ErrorNote>{(bulk.error ?? moveTo.error)?.message}</ErrorNote>}
              {showTimelines && (
                <>
                  {timelines.isSuccess && !timelines.data.items.length && <Empty title="No timeline yet">A timeline sequences clips one after the other. Create one in Timelines.</Empty>}
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3.5">
                    {timelines.data?.items.map((t) => (
                      <Link key={t.id} href={`/timelines/${t.id}`} className="flex flex-col overflow-hidden rounded-[10px] border border-line bg-panel hover:border-accent">
                        <span className="relative flex aspect-video items-center justify-center overflow-hidden bg-raised text-ink-3">
                          {t.cover ? <img src={thumbUrl(t.cover)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" /> : <Film size={26} />}
                        </span>
                        <span className="flex flex-col px-3 py-2">
                          <span className="truncate font-semibold">{t.name}</span>
                          <span className="text-xs text-ink-2">{t.clips === 0 ? "Empty" : `${t.clips} clip${t.clips > 1 ? "s" : ""}${t.durationMs ? ` · ${clock(t.durationMs)}` : ""}`} · {when(t.updatedAt)}</span>
                        </span>
                      </Link>
                    ))}
                  </div>
                </>
              )}
              {!showTimelines && assets.isSuccess && !items.length && !running && (
                <Empty title={filtered ? "No match" : place.type === "bin" ? "The bin is empty" : place.type === "folder" ? "This folder is empty" : "Nothing here yet"}>
                  {filtered
                    ? "Nothing here matches this search, model, LoRA or Kept filter. Change the search or the filters."
                    : place.type === "bin"
                      ? "Items you bin wait here a week before they are deleted for good."
                      : place.type === "folder"
                        ? "What you generate while it is open lands in it. Or drag images onto it from All."
                        : "Images and videos you generate appear here. Start with Create."}
                </Empty>
              )}
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, ${TILE[view.size]})` }}>
                {/* what is being made now comes first, where its result will land */}
                {!showTimelines && running && running.kind === "render" && place.type !== "bin" && !filtered && (
                  <LiveTile
                    job={running}
                    title={running.draftId ? "Open the draft it was queued from" : undefined}
                    // to the draft it comes from: the form opens on it, with what it has made beside it
                    onClick={running.draftId ? () => {
                      openDraft(running.draftId);
                      view.set({ form: true, scope: "draft" });
                    } : undefined}
                  />
                )}
                {items.map((a) => (
                  <Tile
                    key={a.id}
                    asset={a}
                    onOpen={() => setOpen(a)}
                    selected={picked.includes(a.id)}
                    selecting={picked.length > 0}
                    onSelect={(range) => tick(a, range)}
                    dragIds={picked.includes(a.id) ? picked : undefined}
                  />
                ))}
              </div>
              {!showTimelines && assets.hasNextPage && (
                <div className="mt-5 flex justify-center">
                  <Button onClick={() => assets.fetchNextPage()} disabled={assets.isFetchingNextPage}>{assets.isFetchingNextPage ? "Loading…" : "Show more"}</Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {foldersOpen && (
        <Popover anchor={folderButton} onClose={() => setFoldersOpen(false)} label="Folders" width={300} height={520}>
          <FolderPanel
            place={place}
            dragging={foldersOpen === "drag"}
            onPlace={(p) => {
              view.set({ place: p });
              setFoldersOpen(false);
            }}
          />
        </Popover>
      )}
      {open && <Viewer asset={items.find((a) => a.id === open.id) ?? open} items={items} onOpen={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}
