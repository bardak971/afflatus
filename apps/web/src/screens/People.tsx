import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MapPin, Play, Plus, Sparkles, Trash2, User, X, FileDown, Upload, Pencil } from "lucide-react";
import { fuzzyFilter } from "@afflatus/core";
import { useLocation } from "wouter";
import { api, thumbUrl, type Entity, type RecipeInfo } from "../api";
import { useEntities, useRecipes } from "../data";
import { PresetEditor } from "../PresetEditor";
import { ShippedPreset } from "../ShippedPreset";
import { importPresetFile, savePresetFile } from "../presetFile";
import { ContextMenu, useMenu, type MenuItem } from "../ContextMenu";
import { handPreset } from "../handoff";
import { useStudio } from "../store";
import { Button, ErrorNote } from "../ui";
import { ask } from "../Confirm";
import { ItemHeader, noteOfDelete } from "./kit/ItemHeader";
import { KitHeader, TABS, type Tab } from "./kit/KitHeader";
import { PersonEditor, PlaceEditor } from "./kit/PersonEditor";
import { authorOf, PresetList } from "./kit/PresetList";
import { Badge, Mark, Row } from "./kit/Row";
import { remember, remembered, textOf } from "./kit/shared";
import { SnippetTable, type Snippet } from "./kit/SnippetTable";
import { StyleEditor } from "./kit/StyleEditor";
import { useEntityDraft } from "./kit/useEntityDraft";

const TAB_KEY = "afflatus.kit.tab";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** What an item is, at the head of its menu. */
const KIND_WORD = { person: "Person", place: "Place", style: "Style", preset: "Preset", snippet: "Snippet" } as const;
/** One line about an item, under its name. */
function summaryOf(e: Entity, recipes: RecipeInfo[]): string {
  if (e.kind === "person") return `${plural(e.def.pictures.length, "reference image")}, ${e.def.voice ? "voice sample" : "no voice sample"}, ${plural(e.def.outfits.length, "outfit")}`;
  if (e.kind === "place") return plural(e.def.pictures.length, "reference image");
  if (e.kind === "style") return `set up for ${plural(Object.values(e.def.models).filter((m) => m.loras.length || m.words.trim()).length, "model")}`;
  if (e.kind === "preset") return `${e.def.recipe ? (recipes.find((r) => r.id === e.def.recipe)?.title ?? "a model that is no longer here") : "any model"} · ${plural(Object.keys(e.def.inputs).length, "parameter")} set`;
  return e.def.text;
}

/**
 * The prompt kit: everything written once and added to prompts afterwards. The kinds are tabs across
 * the top (people, places, styles, snippets, presets), with a search. Under them, a list on the left
 * and the item that is open on the right, so that the list stays while one is being changed. Presets
 * are grouped by the model they are for, with filters for yours, the shipped ones by author, and the ones whose
 * files are missing. Snippets are changed in a table of their own.
 */
export function People() {
  const entities = useEntities();
  const client = useQueryClient();
  const recipes = useRecipes();
  const [, go] = useLocation();
  const all = entities.data?.items ?? [];
  // the tab named in the address ("/kit#snippets") when there is one, else the one last looked at
  const [tab, setTabNow] = useState<Tab>(() => TABS.find((t) => `#${t.title.toLowerCase()}` === window.location.hash)?.id ?? remembered<Tab>(TAB_KEY, "person"));
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const stored = all.find((e) => e.id === open) ?? null;

  const { edit, saved, failure, flush, retry, change, dropPending } = useEntityDraft({ stored, loading: entities.isLoading });
  /** Another item, or none, with what was changed kept. */
  const select = (id: string | null) => void flush().then(() => setOpen(id));
  const setTab = (next: Tab) => {
    remember(TAB_KEY, next);
    setQuery("");
    void flush().then(() => {
      setOpen(null);
      setTabNow(next);
    });
  };

  const create = useMutation({
    mutationFn: (kind: "person" | "place" | "style" | "preset") => api.createEntity(kind, TABS.find((t) => t.id === kind)!.add),
    onSuccess: async (e) => {
      await client.invalidateQueries({ queryKey: ["entities"] });
      setOpen(e.id);
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteEntity,
    onSuccess: (_, id) => {
      // the change waiting for this item goes with it; another item's still goes out
      dropPending(id);
      setOpen((o) => (o === id ? null : o));
      return client.invalidateQueries({ queryKey: ["entities"] });
    },
  });
  /** Deleting is asked first, from the row's menu as from the item's header. */
  const askRemove = async (e: Entity) => {
    if (await ask({ title: `Delete ${e.name}`, text: noteOfDelete(e), yes: "Delete" })) remove.mutate(e.id);
  };
  /** The right-click menu of a row: what the open item's header offers. */
  const rowMenu = useMenu<Entity>();
  const rowItems = (e: Entity): MenuItem[] => [
    { label: open === e.id ? "Close" : "Open", icon: <Pencil size={14} />, run: () => select(open === e.id ? null : e.id) },
    ...(e.kind === "preset" ? [
      { label: "Apply in Studio", icon: <Play size={14} />, run: () => applyInStudio(e.id) },
      { label: "Save as a file", icon: <FileDown size={14} />, run: () => savePresetFile(e) },
    ] : []),
    ...(e.kind === "preset" && e.source === "shipped" ? [] : ["—" as const, { label: "Delete…", icon: <Trash2 size={14} />, danger: true, run: () => void askRemove(e) }]),
  ];
  const fileInput = useRef<HTMLInputElement>(null);
  const doImport = useMutation({
    mutationFn: async (file: File) => importPresetFile(file),
    onSuccess: async (made) => {
      await client.invalidateQueries({ queryKey: ["entities"] });
      setOpen(made.id);
    },
  });

  const here = TABS.find((t) => t.id === tab)!;
  const mine = all.filter((e) => e.kind === tab);
  const found = query.trim() ? fuzzyFilter(mine, query, textOf) : mine;
  const editing = edit && open === edit.id && edit.kind !== "snippet" ? edit : null;
  // a preset that ships with Afflatus: shown, not changed
  const shipped = editing && editing.kind === "preset" && editing.source === "shipped" ? editing : null;
  const recipeList = recipes.data?.recipes ?? [];
  const applyInStudio = (id: string) => {
    handPreset(id);
    useStudio.getState().set({ form: true });
    go("/");
  };
  const newButton = (
    <button type="button" disabled={create.isPending} onClick={() => create.mutate(tab as "person" | "place" | "style" | "preset")} className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border-[1.5px] border-dashed border-line-strong text-xs font-semibold text-ink-2 hover:border-accent hover:text-ink">
      <Plus size={14} /> {here.add}
    </button>
  );
  /** The head of the list, for every kind: the new button (and the import, for presets), and the word when the search finds nothing. */
  const head = (
    <>
      {!query.trim() && (
        <div className="flex items-center gap-2 pb-1.5">
          {newButton}
          {tab === "preset" && (
            <>
              <Button size="sm" onClick={() => fileInput.current?.click()} disabled={doImport.isPending} data-tip="A preset file: one saved from Afflatus, or one of the shipped shape" className="flex h-9 shrink-0 items-center gap-1.5"><Upload size={13} /> Import</Button>
              <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport.mutate(f); e.target.value = ""; }} />
            </>
          )}
        </div>
      )}
      {mine.length > 0 && found.length === 0 && <div className="px-2 py-6 text-center text-xs text-ink-2">None of your {here.title.toLowerCase()} has these words.</div>}
    </>
  );
  const explain = tab === "person"
    ? "A person is reference images, a voice sample and prompt text. Afflatus gives each model what it can take: tags or natural language, a LoRA, reference images, the voice sample."
    : tab === "place" ? "A place is reference images and prompt text: the clip or the image happens there."
      : tab === "style" ? "A style is LoRAs and prompt text, set up for the models you use it with."
        : "A preset is generation parameters kept under a name: a model and what you set on its form, a prompt, the references. Everything in it is optional. Save one from the form in Studio, under \"Model\", start an empty one here, or copy one of the shipped ones.";

  return (
    <div className="flex min-h-0 min-w-0 grow flex-col">
      <KitHeader tab={tab} onTab={setTab} all={all} query={query} onQuery={setQuery} />

      {rowMenu.menu && <ContextMenu at={rowMenu.menu.at} label="Actions on this item" head={{ title: rowMenu.menu.subject.name, sub: `${KIND_WORD[rowMenu.menu.subject.kind]} · ${summaryOf(rowMenu.menu.subject, recipeList)}` }} items={rowItems(rowMenu.menu.subject)} onClose={rowMenu.close} />}
      {(entities.isError || create.isError || remove.isError || doImport.isError) && <div className="px-6 pb-3"><ErrorNote>{(entities.error ?? create.error ?? remove.error ?? doImport.error)?.message}</ErrorNote></div>}

      {tab === "snippet" ? (
        <main className="min-h-0 grow overflow-y-auto px-6 pb-8">
          <SnippetTable snippets={all.filter((e): e is Snippet => e.kind === "snippet")} query={query} />
        </main>
      ) : (
        <div className="grid min-h-0 grow grid-cols-[440px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r border-line">
            {tab === "preset" ? (
              <PresetList found={found} open={open} onSelect={select} onMenu={(e, ev) => rowMenu.open(ev, e)}>{head}</PresetList>
            ) : (
              <div className="flex min-h-0 grow flex-col gap-1 overflow-y-auto px-3 py-3">
                {head}
                {(tab === "person" || tab === "place") && found.map((e) => {
                  const face = e.kind === "person" || e.kind === "place" ? e.def.pictures[0] : undefined;
                  return (
                    <Row
                      key={e.id} active={open === e.id} onClick={() => select(e.id)} onMenu={(ev) => rowMenu.open(ev, e)} title={e.name} summary={summaryOf(e, recipeList)}
                      mark={<span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-raised text-ink-3">{face ? <img src={thumbUrl(face)} alt="" loading="lazy" className="h-full w-full object-cover" /> : tab === "person" ? <User size={16} /> : <MapPin size={16} />}</span>}
                    />
                  );
                })}
                {tab === "style" && found.map((e) => (
                  <Row key={e.id} active={open === e.id} onClick={() => select(e.id)} onMenu={(ev) => rowMenu.open(ev, e)} title={e.name} summary={summaryOf(e, recipeList)} mark={<Mark><Sparkles size={12} /></Mark>} />
                ))}
              </div>
            )}
          </aside>

          <section className="min-h-0 overflow-y-auto px-8 py-5">
            {shipped ? (
              <div className="mx-auto flex max-w-3xl flex-col gap-5">
                <div className="flex items-center gap-3">
                  <h2 className="min-w-0 grow truncate text-xl font-semibold">{shipped.name}</h2>
                  <Badge>{authorOf(shipped)}</Badge>
                  <Button size="sm" tone="primary" onClick={() => applyInStudio(shipped.id)} className="flex items-center gap-1.5"><Play size={13} /> Apply in Studio</Button>
                  <Button size="sm" onClick={() => savePresetFile(shipped)} className="flex items-center gap-1.5"><FileDown size={13} /> Save as a file</Button>
                  <button type="button" aria-label="Close" onClick={() => select(null)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={15} /></button>
                </div>
                <ShippedPreset e={shipped} onCopied={(c) => setOpen(c.id)} />
              </div>
            ) : editing ? (
              <div className="mx-auto flex max-w-3xl flex-col gap-5">
                <ItemHeader
                  item={editing} saved={saved} failure={failure} onRename={(name) => change({ ...editing, name })} onRetry={retry}
                  onApply={() => void flush().then(() => applyInStudio(editing.id))} onDelete={() => remove.mutate(editing.id)} onClose={() => select(null)}
                />
                {editing.kind === "person" && <PersonEditor def={editing.def} name={editing.name || "this person"} onChange={(def) => change({ ...editing, def })} />}
                {editing.kind === "place" && <PlaceEditor def={editing.def} name={editing.name || "this place"} onChange={(def) => change({ ...editing, def })} />}
                {editing.kind === "style" && <StyleEditor def={editing.def} onChange={(def) => change({ ...editing, def })} />}
                {editing.kind === "preset" && <PresetEditor id={editing.id} def={editing.def} onChange={(def) => change({ ...editing, def })} />}
              </div>
            ) : (
              <div className="mx-auto flex max-w-xl flex-col items-center gap-4 pt-16 text-center">
                <span className="text-ink-3">{here.icon}</span>
                <h2 className="text-lg font-semibold">{mine.length ? `Choose ${tab === "person" ? "a person" : tab === "place" ? "a place" : tab === "style" ? "a style" : "a preset"} on the left` : `No ${here.title.toLowerCase()} yet`}</h2>
                <p className="text-ink-2">{explain}</p>
                <Button onClick={() => create.mutate(tab as "person" | "place" | "style" | "preset")} disabled={create.isPending} className="flex items-center gap-2"><Plus size={14} /> {here.add}</Button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
