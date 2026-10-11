import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CopyPlus, Eye, Link2, MapPin, Play, Plus, Sparkles, Trash2, User, X, FileDown, Upload, Pencil } from "lucide-react";
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
import { Thumb } from "../Thumb";
import { Button, cx, ErrorNote, Help } from "../ui";
import { ask, askText } from "../Confirm";
import { copyText } from "../secureContext";
import { ItemHeader, noteOfDelete } from "./kit/ItemHeader";
import { KitHeader, TABS, type Tab } from "./kit/KitHeader";
import { kitHash, kitHref, readKitHash } from "./kit/link";
import { PersonEditor, PlaceEditor } from "./kit/PersonEditor";
import { presetGroups, PresetList } from "./kit/PresetList";
import { Mark, Row } from "./kit/Row";
import { outfitsOf, remember, remembered, textOf } from "./kit/shared";
import { SnippetTable, type Snippet } from "./kit/SnippetTable";
import { StyleEditor } from "./kit/StyleEditor";
import { useEntityDraft } from "./kit/useEntityDraft";
import { plural } from "../format";
import { queryKeys } from "../queryKeys";

const TAB_KEY = "afflatus.kit.tab";

/** What an item is, at the head of its menu. */
const KIND_WORD = { person: "Person", place: "Place", style: "Style", preset: "Preset", snippet: "Snippet" } as const;
/** One line about an item, under its name: terse, the list is read at a glance. */
function summaryOf(e: Entity, recipes: RecipeInfo[]): string {
  if (e.kind === "person") return `${plural(e.def.pictures.length, "picture")} · ${e.def.voice ? "voice" : "no voice"} · ${plural(outfitsOf(e.def.outfits).length, "outfit")}`;
  if (e.kind === "place") return plural(e.def.pictures.length, "picture");
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
  // the tab and the item named in the address ("/kit#people/<id>", "/kit#snippets") when there are, else the tab last looked at
  const [start] = useState(() => readKitHash(window.location.hash));
  const [tab, setTabNow] = useState<Tab>(() => start?.tab ?? remembered<Tab>(TAB_KEY, "person"));
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(start?.id ?? null);
  // the Snippets tab: the one category shown (the New button makes a snippet in it) and the snippet just made
  const [snippetOnly, setSnippetOnly] = useState<string | null>(null);
  const [freshSnippet, setFreshSnippet] = useState<string | null>(null);
  const stored = all.find((e) => e.id === open) ?? null;

  const { edit, saved, failure, flush, retry, change, dropPending } = useEntityDraft({ stored, loading: entities.isLoading });
  /** Another item, or none, with what was changed kept. */
  const select = (id: string | null) => void flush().then(() => setOpen(id));
  /** Another tab, with an item of it open or none. */
  const setTab = (next: Tab, item: string | null = null) => {
    remember(TAB_KEY, next);
    setQuery("");
    void flush().then(() => {
      setOpen(item);
      setSnippetOnly(null);
      setTabNow(next);
    });
  };

  // the address says where the kit is: replaced, not pushed, so that walking the list leaves no trail in the history
  useEffect(() => {
    const hash = kitHash(tab, open);
    if (window.location.hash !== hash) history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
  }, [tab, open]);
  // and a link followed while the kit is open (the back button, a cast's "Open in the kit", the command bar) moves it there
  const follow = useRef<() => void>(() => {});
  follow.current = () => {
    const to = window.location.pathname.startsWith("/kit") ? readKitHash(window.location.hash) : null;
    if (!to || (to.tab === tab && to.id === open)) return;
    if (to.tab !== tab) setTab(to.tab, to.id);
    else select(to.id);
  };
  useEffect(() => {
    const moved = () => follow.current();
    const events = ["hashchange", "popstate", "pushState"];
    for (const e of events) window.addEventListener(e, moved);
    return () => {
      for (const e of events) window.removeEventListener(e, moved);
    };
  }, []);

  const create = useMutation({
    mutationFn: (kind: "person" | "place" | "style" | "preset") => api.createEntity(kind, TABS.find((t) => t.id === kind)!.add),
    onSuccess: async (e) => {
      await client.invalidateQueries({ queryKey: queryKeys.entities() });
      setOpen(e.id);
    },
  });
  const createSnippet = useMutation({
    mutationFn: () => api.createEntity("snippet", "New snippet", { text: "", category: snippetOnly ?? "", style: null }),
    onSuccess: async (made) => {
      await client.invalidateQueries({ queryKey: queryKeys.entities() });
      setFreshSnippet(made.id);
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteEntity,
    onSuccess: (_, id) => {
      // the change waiting for this item goes with it; another item's still goes out
      dropPending(id);
      setOpen((o) => (o === id ? null : o));
      return client.invalidateQueries({ queryKey: queryKeys.entities() });
    },
  });
  /** Deleting is asked first, from the row's menu as from the item's header. */
  const askRemove = async (e: Entity) => {
    if (await ask({ title: `Delete ${e.name}?`, text: noteOfDelete(e), yes: "Delete" })) remove.mutate(e.id);
  };
  /** A copy of an item, as it is now on screen (with what is not saved yet), named "… copy" and opened. */
  const duplicate = useMutation({
    mutationFn: async (e: Entity) => {
      await flush();
      const now = edit && edit.id === e.id ? edit : e;
      return api.createEntity(now.kind, `${now.name} copy`, now.def);
    },
    onSuccess: async (made) => {
      await client.invalidateQueries({ queryKey: queryKeys.entities() });
      setOpen(made.id);
    },
  });
  /** A new name, asked for: the open item's goes through its draft (as its header's name does), another's straight to the server. */
  const renameIt = async (e: Entity) => {
    const name = await askText({ title: "Rename", value: e.name, placeholder: "A name for it", yes: "Rename" });
    if (name === null || !name.trim() || name === e.name) return;
    if (editing && editing.id === e.id) change({ ...editing, name });
    else void api.saveEntity(e.id, { name }).then(() => client.invalidateQueries({ queryKey: queryKeys.entities() }));
  };
  /** The right-click menu of a row, also the open item's ··· menu: what its header offers, and Delete…. */
  const rowMenu = useMenu<Entity>();
  const rowItems = (e: Entity): MenuItem[] => [
    open === e.id
      ? { label: "Close", icon: <X size={14} />, run: () => select(null) }
      : { label: "Open", icon: <Eye size={14} />, run: () => select(e.id) },
    // a preset that ships with Afflatus keeps its name; its copy can be renamed
    ...(e.kind === "preset" && e.source === "shipped" ? [] : [{ label: "Rename…", icon: <Pencil size={14} />, run: () => void renameIt(e) }]),
    { label: "Duplicate", icon: <CopyPlus size={14} />, note: "opened as a copy", disabled: duplicate.isPending, run: () => duplicate.mutate(e) },
    { label: "Copy link", icon: <Link2 size={14} />, run: () => void copyText(`${window.location.origin}${kitHref(e.kind, e.id)}`).catch(() => {}) },
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
      await client.invalidateQueries({ queryKey: queryKeys.entities() });
      setOpen(made.id);
    },
  });

  const here = TABS.find((t) => t.id === tab)!;
  const mine = all.filter((e) => e.kind === tab);
  // A tab arrived on with nothing open opens its first entry, rather than a "Choose one" page and one more click. Once per
  // arrival: an item closed by hand stays closed, and an item named in the address (a deep link) is the one opened.
  // Presets open the first row of their list as it is drawn, grouped by model: so it waits for the models as well.
  const arrived = useRef<Tab | null>(null);
  const firstOf = tab === "snippet" ? null
    : tab === "preset" ? presetGroups(mine, recipes.data?.recipes ?? [], recipes.data?.families ?? [])[0]?.items[0]?.id ?? null
    : mine[0]?.id ?? null;
  const ready = entities.isSuccess && (tab !== "preset" || recipes.isSuccess);
  useEffect(() => {
    if (!ready || arrived.current === tab) return;
    arrived.current = tab;
    if (open === null && firstOf) setOpen(firstOf);
  }, [ready, tab, open, firstOf]);
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
  /** The one New button, in the header: for the tab open (a snippet goes into the category shown). */
  const onNew = () => (tab === "snippet" ? createSnippet.mutate() : create.mutate(tab));
  /** Before it, for presets: bringing one in from a file. */
  const importButton = tab === "preset" && (
    <>
      <Button size="sm" onClick={() => fileInput.current?.click()} disabled={doImport.isPending} data-tip="A preset file: one saved from Afflatus, or one of the shipped shape" className="flex h-9 shrink-0 items-center gap-1.5"><Upload size={13} /> Import</Button>
      <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport.mutate(f); e.target.value = ""; }} />
    </>
  );
  const explain = tab === "person"
    ? "A person is reference images, a voice sample and prompt text. Afflatus gives each model what it can take: tags or natural language, a LoRA, reference images, the voice sample."
    : tab === "place" ? "A place is reference images and prompt text: the clip or the image happens there."
      : tab === "style" ? "A style is LoRAs and prompt text, set up for the models you use it with."
        : "A preset is generation parameters kept under a name: a model and what you set on its form, a prompt, the references. Everything in it is optional. Save one from the form in Studio, under \"Model\", start an empty one here, or copy one of the shipped ones.";
  /**
   * The head of the list: the word when the search finds nothing, and on an empty tab the next step where
   * the rows would be (the New button at the top right was the only way in, far from the empty column).
   */
  const head = entities.isLoading
    // the kit on its way: rows as the list draws them, with the loading shine, rather than an empty list or "No … yet"
    ? <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-1">{[0, 1, 2, 3, 4].map((i) => <PlaceholderRow key={i} big={tab === "person" || tab === "place"} />)}</div>
    : mine.length > 0 && found.length === 0
    ? <div className="px-2 py-6 text-center text-xs text-ink-2">None of your {here.title.toLowerCase()} has these words.</div>
    : entities.isSuccess && mine.length === 0 && (
      <div className="flex flex-col items-center gap-3 px-2 py-8 text-center">
        <span className="flex items-center gap-1.5 text-xs text-ink-2">No {here.title.toLowerCase()} yet <Help text={explain} title={here.title} /></span>
        <Button size="sm" tone="primary" disabled={create.isPending} onClick={onNew} className="flex items-center gap-1.5"><Plus size={13} /> {here.add}</Button>
      </div>
    );

  return (
    <div className="flex min-h-0 min-w-0 grow flex-col">
      <KitHeader
        tab={tab} onTab={setTab} all={all} loading={entities.isLoading} query={query} onQuery={setQuery} extra={importButton}
        newLabel={tab === "snippet" && snippetOnly ? `New snippet in ${snippetOnly}` : undefined}
        onNew={onNew} busy={create.isPending || createSnippet.isPending}
      />

      {rowMenu.menu && <ContextMenu at={rowMenu.menu.at} label="Actions on this item" head={{ title: rowMenu.menu.subject.name, sub: `${KIND_WORD[rowMenu.menu.subject.kind]} · ${summaryOf(rowMenu.menu.subject, recipeList)}` }} items={rowItems(rowMenu.menu.subject)} onClose={rowMenu.close} />}
      {(entities.isError || create.isError || createSnippet.isError || remove.isError || doImport.isError) && <div className="px-6 pt-3"><ErrorNote>{(entities.error ?? create.error ?? createSnippet.error ?? remove.error ?? doImport.error)?.message}</ErrorNote></div>}

      {tab === "snippet" ? (
        <main className="min-h-0 grow overflow-y-auto px-6 pt-4 pb-8">
          <SnippetTable snippets={all.filter((e): e is Snippet => e.kind === "snippet")} query={query} only={snippetOnly} onOnly={setSnippetOnly} fresh={freshSnippet} />
        </main>
      ) : (
        <div className={cx("grid min-h-0 grow", tab === "preset" ? "grid-cols-[420px_minmax(0,1fr)]" : "grid-cols-[320px_minmax(0,1fr)]")}>
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
                      mark={<span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[3px] bg-raised text-ink-3">{face ? <Thumb src={thumbUrl(face)} alt="" loading="lazy" className="h-full w-full object-cover" /> : tab === "person" ? <User size={16} /> : <MapPin size={16} />}</span>}
                    />
                  );
                })}
                {tab === "style" && found.map((e) => (
                  <Row key={e.id} active={open === e.id} onClick={() => select(e.id)} onMenu={(ev) => rowMenu.open(ev, e)} title={e.name} summary={summaryOf(e, recipeList)} mark={<Mark><Sparkles size={12} /></Mark>} />
                ))}
              </div>
            )}
          </aside>

          <section className="min-h-0 overflow-y-auto px-7 py-4">
            {shipped ? (
              <ShippedPreset e={shipped} onApply={() => applyInStudio(shipped.id)} onDuplicate={() => duplicate.mutate(shipped)} duplicating={duplicate.isPending} onClose={() => select(null)} />
            ) : editing ? (
              // a preset's form keeps its reading width; a person, a place or a style uses the column's (two halves once
              // it is wide, see PersonEditor's Halves), not the left 820 px of a wide screen
              <div className={cx("@container/editor flex flex-col gap-3", editing.kind === "preset" ? "max-w-[820px]" : "max-w-[1600px]")}>
                {/* each editor is keyed by its item: another item opens a fresh one, so an upload or a picker left open never lands on it */}
                <ItemHeader
                  item={editing} saved={saved} failure={failure} onRename={(name) => change({ ...editing, name })} onRetry={retry}
                  onApply={() => void flush().then(() => applyInStudio(editing.id))} onMenu={(ev) => rowMenu.open(ev, editing)} onClose={() => select(null)}
                />
                {editing.kind === "person" && <PersonEditor key={editing.id} def={editing.def} name={editing.name || "this person"} onChange={(def) => change({ ...editing, def })} />}
                {editing.kind === "place" && <PlaceEditor key={editing.id} def={editing.def} name={editing.name || "this place"} onChange={(def) => change({ ...editing, def })} />}
                {editing.kind === "style" && <StyleEditor key={editing.id} def={editing.def} onChange={(def) => change({ ...editing, def })} />}
                {editing.kind === "preset" && <PresetEditor key={editing.id} id={editing.id} def={editing.def} onChange={(def) => change({ ...editing, def })} />}
              </div>
            ) : (
              // nothing open: the kind's icon and one line; what the kind is, behind its ?
              <div className="flex max-w-[820px] flex-col items-center gap-3 pt-24 text-center">
                <span className="text-ink-3">{here.icon}</span>
                <h2 className="flex items-center gap-2 text-base font-semibold">
                  {/* an empty tab says so once, in the list column, beside its New button */}
                  {mine.length > 0 && <>Choose {tab === "person" ? "a person" : tab === "place" ? "a place" : tab === "style" ? "a style" : "a preset"} on the left <Help text={explain} title={here.title} /></>}
                </h2>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/** A row of the list while the kit loads, laid out as Row is: its mark (a picture for people and places), its name over its line. */
function PlaceholderRow({ big }: { big: boolean }) {
  return (
    <div aria-hidden className="flex w-full items-center gap-3 rounded-[11px] border border-transparent px-2 py-2">
      <span className={cx("m-skeleton shrink-0", big ? "h-10 w-10 rounded-[3px]!" : "h-6 w-6 rounded!")} />
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="text-sm"><span className="m-skeleton inline-block h-[0.8em] w-1/2 align-middle" /></span>
        <span className="text-xs"><span className="m-skeleton inline-block h-[0.8em] w-3/4 align-middle" /></span>
      </span>
    </div>
  );
}
