import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { Link, useLocation } from "wouter";
import { create } from "zustand";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, FileUp, MoreHorizontal, Pencil, Play, Trash2 } from "lucide-react";
import { ContextMenu, headLine, useMenu, type MenuItem } from "../ContextMenu";
import { ask } from "../Confirm";
import { guessModel, readBindings, type Bindings } from "@afflatus/workflows";
import { useOpenInComfy } from "../actions";
import { api, ApiError, type RecipeStatus, type WorkflowBrief } from "../api";
import { useRecipes, useSettings, useSetup, useWorkflows } from "../data";
import { useOpenNewDraft } from "../draft";
import { notReady, plural, recipeLabel } from "../format";
import { saveJson } from "../download";
import { useHandover } from "../store";
import { useWorkflowsRequest, workflowEditHref } from "../bar/bridge";
import { settingHref } from "./settings/settingsIndex";
import { Button, Chip, cx, Empty, ErrorNote, Help, PageHeader, SectionTitle } from "../ui";
import { WorkflowEditor, type Editing } from "./WorkflowEditor";
import { WorkflowEditorSkeleton } from "./workflowEditor/EditorSkeleton";
import { queryKeys } from "../queryKeys";

/**
 * Read a file the user chose: a workflow as ComfyUI saves it, one saved with "Export (API)", or one
 * shared from another Afflatus (the same workflow with its mapping already made).
 */
/** The workflow in a file: a .json, or a picture or video ComfyUI saved with its workflow inside (read by the server, as a dropped file is). */
async function workflowIn(file: File): Promise<unknown> {
  const picture = file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name);
  if (picture || file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v|mkv)$/i.test(file.name)) {
    const { workflow } = await api.embedded(file);
    if (!workflow) {
      throw new ApiError(picture
        ? "This picture carries no workflow. ComfyUI writes one into the pictures it saves; a picture from elsewhere has none."
        : "This video carries no workflow. ComfyUI's video savers write one into the videos they make; a video from elsewhere has none.");
    }
    return workflow;
  }
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new ApiError("This file could not be parsed. A workflow is a .json file, or a picture or video ComfyUI saved with its workflow inside.");
  }
}

async function readFile(file: File): Promise<Editing> {
  const json: unknown = await workflowIn(file);
  const shared = json && typeof json === "object" && "graph" in json && "bindings" in json ? (json as { graph: unknown; wiring?: unknown; bindings: unknown; title?: unknown; model?: unknown }) : null;
  // the server answers with the workflow in the form Afflatus keeps, whatever form the file was in
  const inspection = await api.inspectWorkflow(shared ? { graph: shared.graph, wiring: shared.wiring } : json);
  let bindings: Bindings | null = inspection.suggested;
  if (shared) {
    // read without zod, which would add some 90 kB for this one check: the server checks them again with the schema
    const read = readBindings(shared.bindings);
    if (!read) throw new ApiError("This looks like a workflow shared from Afflatus, but its bindings could not be read.");
    bindings = read;
  }
  if (!bindings) {
    // a save node of a pack this ComfyUI lacks is not known to be an output: the missing nodes are the news, not the output
    const missing = inspection.missingNodes ?? [];
    if (missing.length) {
      const packs = [...new Set(Object.values(inspection.packs ?? {}))];
      const some = missing.slice(0, 4).join(", ") + (missing.length > 4 ? ` and ${missing.length - 4} more` : "");
      throw new ApiError(`This ComfyUI is missing ${plural(missing.length, "node type")} this workflow uses (${some})${packs.length ? `, from ${packs.join(", ")}` : ""}. Install ${packs.length > 1 ? "those packs" : "the pack"} in ComfyUI (ComfyUI-Manager's "Install missing custom nodes" takes them from the workflow), restart it, then import again.`);
    }
    throw new ApiError("This workflow has no output: no Save or Preview node for an image, a video or audio.");
  }
  return {
    id: null,
    source: file.name,
    title: typeof shared?.title === "string" ? shared.title : file.name.replace(/\.(json|png|mp4|webm|mov|m4v|mkv)$/i, "").replace(/\s*\(API\)$/i, ""),
    // a guess from the loaders and files, for the Model field to start with; the person can change it
    model: typeof shared?.model === "string" ? shared.model : guessModel(inspection.graph as Parameters<typeof guessModel>[0]),
    graph: inspection.graph,
    wiring: inspection.wiring,
    editor: inspection.editor,
    inspection,
    bindings,
  };
}

/** A saved workflow, opened again to change its mapping. */
async function reopen(id: string): Promise<Editing> {
  const def = await api.workflow(id);
  // what the reader learns from the file itself (the author's frames, the links in its notes) is read again: a
  // workflow saved before the reader knew to keep them gains them; the saved graph and mapping stay as they are
  let wiring = def.wiring;
  if (def.editor && def.wiring) {
    const fresh = await api.inspectWorkflow(def.editor).catch(() => null);
    if (fresh?.wiring) wiring = { ...def.wiring, frames: fresh.wiring.frames, links: fresh.wiring.links };
  }
  const inspection = await api.inspectWorkflow({ graph: def.graph, wiring });
  return { id: def.id, source: def.source, title: def.title, model: def.model, graph: def.graph, wiring, editor: def.editor, inspection, bindings: def.bindings };
}

/** The workflow with its mapping, as a file someone else can import into their Afflatus (the command bar's Export too). */
export async function share(w: Pick<WorkflowBrief, "id" | "title">): Promise<void> {
  const { id: _id, ...def } = await api.workflow(w.id);
  saveJson(def, `${w.title.replace(/[^\w .-]+/g, "").trim() || "workflow"}.afflatus.json`);
}

/**
 * A fresh import until it is saved. It has no id yet, so /workflows/new draws it from here, and it lives in this
 * tab's memory only: a reload finds it gone. `note` is what the list says on its return from an editor that could
 * not be drawn (the import lost to a reload, a saved workflow that could not be read).
 */
export const useWorkflowDraft = create<{ draft: Editing | null; note: string | null }>(() => ({ draft: null, note: null }));

/**
 * /workflows/:id/edit: a saved workflow in the editor. It is read afresh each time it is opened (nothing kept
 * once it is left), so the editor starts from what is saved; one that cannot be read returns to the list, which says why.
 */
export function WorkflowEdit({ params }: { params: { id: string } }) {
  const id = params.id;
  const [, navigate] = useLocation();
  const q = useQuery({ queryKey: queryKeys.workflowEdit(id), queryFn: () => reopen(id), staleTime: Infinity, gcTime: 0, retry: false, refetchOnWindowFocus: false });
  useEffect(() => {
    useWorkflowDraft.setState({ note: null });
  }, []);
  useEffect(() => {
    if (!q.error) return;
    useWorkflowDraft.setState({ note: `Could not open it in the editor: ${q.error.message}` });
    navigate("/workflows", { replace: true });
  }, [q.error]); // eslint-disable-line react-hooks/exhaustive-deps -- once per error: navigate is not a value to follow
  // the editor's shape while the saved workflow is read, the same as while its code loads: nothing jumps once it is there
  if (!q.data) return <WorkflowEditorSkeleton />;
  return <WorkflowEditor key={id} start={q.data} onDone={() => navigate("/workflows")} />;
}

/**
 * /workflows/new: the import just read, until it is saved. Opened with nothing in memory (a reload, a link), it was
 * lost: the list says so, in place of this address in the history. Whether it was lost is settled once, when the
 * screen opens, so that the draft let go on Save or Cancel does not read as lost on the way out.
 */
export function WorkflowImport() {
  const draft = useWorkflowDraft((s) => s.draft);
  const [lost] = useState(() => !useWorkflowDraft.getState().draft);
  const [, navigate] = useLocation();
  useEffect(() => {
    if (!lost) {
      useWorkflowDraft.setState({ note: null });
      return;
    }
    useWorkflowDraft.setState({ note: "The import was not saved and the page was reloaded: drop its file again." });
    navigate("/workflows", { replace: true });
  }, [lost]); // eslint-disable-line react-hooks/exhaustive-deps -- once per lost import: navigate is not a value to follow
  if (!draft) return null;
  return (
    <WorkflowEditor
      key={`${draft.source}:${draft.title}`}
      start={draft}
      onDone={() => {
        navigate("/workflows");
        useWorkflowDraft.setState({ draft: null });
      }}
    />
  );
}

const KIND = { image: "Image", video: "Video", audio: "Audio" } as const;

/**
 * What a workflow lacks that can be fetched, counted: the node packs first, as notReady says them first, then the model
 * files. Null when what is wrong is not a thing to get (ComfyUI not answering, a graph it would refuse).
 */
function toGet(status: RecipeStatus | undefined): string | null {
  if (!status || status.ready) return null;
  if (status.missingNodes.length) return `${plural(status.missingNodes.length, "node")} to get`;
  const files = status.missingFiles.length || status.missingSlots.length;
  return files ? `${plural(files, "file")} to get` : null;
}

/**
 * The way to put a workflow right, when the editor can: its "Before it can run" lists the missing node
 * packs and model files, with their downloads. Null when the editor has nothing to offer (ComfyUI not
 * answering, a ready workflow).
 */
function fixOf(status: RecipeStatus | undefined, problem: string | undefined): { label: string; tip: string } | null {
  if (problem) return { label: "Edit", tip: "Opens it in the editor, where what it cannot be built from is set right" };
  if (!status || status.ready) return null;
  if (status.missingNodes.length) return { label: "Get nodes", tip: "Opens it in the editor, at \"Before it can run\": the node packs it needs" };
  if (status.missingFiles.length || status.missingSlots.length || status.emptyInputs.length) return { label: "Get files", tip: "Opens it in the editor, at \"Before it can run\": the model files it needs, with their downloads" };
  return null;
}

/**
 * A model family's recipes as one status: what any of them lacks, each named once. A built-in row counts and fixes
 * it the way an imported workflow's row does its own.
 */
function familyStatus(list: Array<RecipeStatus | undefined>): RecipeStatus | undefined {
  const known = list.filter((s): s is RecipeStatus => Boolean(s));
  if (!known.length) return undefined;
  const all = (k: "missingNodes" | "missingSlots" | "emptyInputs" | "missingFiles" | "problems") => [...new Set(known.flatMap((s) => s[k] ?? []))];
  return { ...known[0]!, ready: known.every((s) => s.ready), missingNodes: all("missingNodes"), missingSlots: all("missingSlots"), emptyInputs: all("emptyInputs"), missingFiles: all("missingFiles"), problems: all("problems") };
}

/**
 * Ready, or what it lacks, with a ? that says why, naming what is missing. One look for imported and built-in rows; the
 * way to put it right is a button of the row's own, with its other actions. Files or nodes not fetched yet are a count in
 * the neutral colour, as Settings › Models says it ("2 files to get"): nothing is broken by a model not downloaded yet.
 * Red is kept for a workflow that cannot run as it is (`broken`: a graph ComfyUI would refuse, a mapping that cannot be built).
 */
function Readiness({ known, why, get, broken }: { known: boolean; why: string | null; get?: string | null; broken?: boolean }) {
  if (!known) return <span aria-hidden className="m-skeleton h-6 w-20 rounded-lg" />;
  return (
    <Chip tone={!why ? "good" : broken ? "warn" : "neutral"} className="justify-self-start">
      {!why ? "Ready" : get && !broken ? get : "Not ready"}
      {why && <Help title="Not ready" text={why} />}
    </Chip>
  );
}

/** A card of rows still on its way: a few placeholder bars in the shape the rows will take. */
function Placeholder({ rows, tall }: { rows: number; tall?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="overflow-hidden rounded-xl border border-line bg-panel">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cx("flex items-center gap-3.5 px-4", tall ? "py-3.5" : "py-3", i > 0 && "border-t border-line")}>
          {tall && <span className="m-skeleton h-5 w-12 rounded-md" />}
          <span className="flex grow flex-col gap-1.5">
            <span className="m-skeleton h-3.5 w-56 max-w-full rounded" />
            <span className="m-skeleton h-2.5 w-96 max-w-full rounded opacity-70" />
          </span>
          <span className="m-skeleton h-6 w-20 rounded-lg" />
          {tall && <span className="m-skeleton h-8 w-36 rounded-lg" />}
        </div>
      ))}
    </div>
  );
}

const HOW_TO = [
  "1. Build it and check it works in ComfyUI, as usual.",
  "2. Find its file: ComfyUI keeps the workflows you save in user/default/workflows. A Workflow › Export (API) file works too.",
  "3. Drop it anywhere on this page. Afflatus shows what it found (prompt, image inputs, output, bypass switches) and you correct what is wrong.",
  "",
  "Prefer the file ComfyUI saves: it keeps bypassed and muted nodes, which become switches. An API export has only what was active.",
  "A workflow shared from another Afflatus imports the same way.",
].join("\n");

export function Workflows() {
  const list = useWorkflows();
  const recipes = useRecipes();
  const setup = useSetup();
  const settings = useSettings();
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  // the row menu was opened from its ··· (only what the row has no button for), not by a right-click
  const [fromMore, setFromMore] = useState(false);

  const [, navigate] = useLocation();
  // the editor has an address of its own: a fresh import is held in memory under /workflows/new, a saved workflow is read at its own
  const open = useMutation({
    mutationFn: readFile,
    onSuccess: (draft) => {
      useWorkflowDraft.setState({ draft, note: null });
      navigate("/workflows/new");
    },
  });
  const editIt = (id: string) => navigate(workflowEditHref(id));
  const note = useWorkflowDraft((s) => s.note);
  // a workflow taken out of a picture or a video that was dropped on the app
  const handed = useHandover((h) => h.workflow);
  const hand = useHandover((h) => h.set);
  useEffect(() => {
    if (!handed) return;
    hand({ workflow: null });
    open.mutate(handed);
  }, [handed]); // eslint-disable-line react-hooks/exhaustive-deps -- once per handed workflow: hand and open are not values to follow
  // what the command bar asked of this screen: the file picker of the Import button (its Edit goes to the editor's address)
  const asked = useWorkflowsRequest((r) => r.request);
  useEffect(() => {
    if (!asked) return;
    const r = useWorkflowsRequest.getState().take();
    if (r?.do === "import") input.current?.click();
  }, [asked]);
  const shareIt = useMutation({ mutationFn: share });
  // the workflow in ComfyUI's editor: written into its workflows folder, then ComfyUI opened in a new tab.
  // The tab is opened before the request, or the browser would block it as a pop-up.
  const [opened, setOpened] = useState<{ id: string; direct: boolean; path?: string; restart?: boolean } | null>(null);
  const openInComfy = useOpenInComfy((w: WorkflowBrief) => api.openWorkflow(w.id), { onSuccess: (r, w) => setOpened({ id: w.id, ...r }) });
  const openNew = useOpenNewDraft();
  // straight to the form on a new draft with the workflow picked: nothing is rendered until Generate is pressed
  const tryIt = useMutation({
    mutationFn: (workflow: string) => {
      const recipe = recipes.data?.recipes.find((r) => r.id === workflow);
      if (!recipe) throw new Error("This workflow is not in the model list yet. Reload the page.");
      return api.createDraft({ recipe: recipe.id });
    },
    onSuccess: openNew,
  });
  // right-click on a workflow: what its buttons do
  const cardMenu = useMenu<WorkflowBrief>();
  const cardItems = (w: WorkflowBrief): MenuItem[] => [
    { label: "Try it", icon: <Play size={14} />, note: tryIt.isPending ? "opening…" : "the form, on a new draft", disabled: tryIt.isPending, run: () => tryIt.mutate(w.id) },
    { label: "Edit", icon: <Pencil size={14} />, note: "its mapping and form", run: () => editIt(w.id) },
    "—",
    { label: "Export", icon: <Download size={14} />, note: "a file another Afflatus imports", run: () => shareIt.mutate(w) },
    { label: "Open in ComfyUI", icon: <ExternalLink size={14} />, disabled: openInComfy.isPending || !comfyOnline, note: comfyOnline ? (openInComfy.isPending ? "opening…" : undefined) : "ComfyUI is not running", run: () => openInComfy.mutate(w) },
    "—",
    { label: "Remove…", icon: <Trash2 size={14} />, danger: true, note: "what it made stays in the library", run: () => void ask({ title: `Remove ${w.title}?`, text: "What you generated with it stays in your library.", yes: "Remove" }).then((yes) => yes && remove.mutate(w.id)) },
  ];
  const remove = useMutation({
    mutationFn: api.deleteWorkflow,
    onSuccess: () => Promise.all([queryKeys.recipes(), queryKeys.setup(), queryKeys.workflows()].map((queryKey) => client.invalidateQueries({ queryKey }))),
  });

  const comfyOnline = setup.data?.comfy.online ?? false;
  const why = (recipeId: string) => (setup.isSuccess ? notReady(setup.data.recipes.find((r) => r.id === recipeId), comfyOnline) : null);
  const builtIn = (recipes.data?.families ?? []).filter((f) => !f.imported);
  // the error of the last action only: one that went through since clears an older one
  const last = [open, shareIt, tryIt, remove, openInComfy].reduce((a, m) => (m.submittedAt > a.submittedAt ? m : a));
  // the list's own error is said in its place, under "Your workflows". What an editor that could not open left to say
  // stands until the first action here.
  const error = last.error?.message ?? (last.submittedAt ? null : note);

  // the whole page takes a dropped file; leaving for one of its own children is not leaving it
  const drop = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      const file = e.dataTransfer.files[0];
      if (file) open.mutate(file);
    },
  };
  // the ··· of a row: its menu under the button, or, opened from the keyboard, with its first item active
  const more = (e: MouseEvent<HTMLButtonElement>, w: WorkflowBrief) => {
    const r = e.currentTarget.getBoundingClientRect();
    const keyed = e.detail === 0;
    setFromMore(true);
    cardMenu.open({ preventDefault: () => e.preventDefault(), clientX: keyed ? 0 : r.right - 296, clientY: keyed ? 0 : r.bottom + 4, currentTarget: e.currentTarget }, w);
  };
  const menuOf = cardMenu.menu?.subject;

  return (
    // the whole page takes a dropped file, its header too
    <div className="flex min-h-0 grow flex-col" {...drop}>
      <PageHeader
        title="Workflows"
        after={<Help title="Workflows" text={"Everything Afflatus can generate images and videos with: the models built into Afflatus and the ComfyUI workflows you import. Each one appears under \"Model\" in Studio's form."} />}
        actions={
          <>
            <span className={cx("flex h-8 items-center gap-2 rounded-control border-[1.5px] border-dashed px-3.5 text-body", over ? "border-accent bg-accent-wash text-accent" : "border-line-strong text-ink-2")}>
              {over ? "Drop to import" : "Drop a .json, PNG or MP4 anywhere"}
              <Help title="How to import a workflow from ComfyUI" text={HOW_TO} />
            </span>
            <Button size="sm" tone="primary" onClick={() => input.current?.click()} disabled={open.isPending}>
              <FileUp size={14} /> {open.isPending ? "Reading…" : "Import ComfyUI workflow"}
            </Button>
            <input
              ref={input}
              type="file"
              accept=".json,application/json,image/png,video/mp4,video/webm,.mov,.m4v,.mkv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) open.mutate(f);
                e.target.value = "";
              }}
            />
          </>
        }
      />
      <div className="flex min-h-0 grow flex-col gap-5 overflow-y-auto px-8 pt-5 pb-8">

        {error && <ErrorNote>{error}</ErrorNote>}

        {cardMenu.menu && menuOf && (
          <ContextMenu
            at={cardMenu.menu.at}
            label={`Actions on ${menuOf.title}`}
            head={{ title: recipeLabel(menuOf.model, menuOf.title), sub: headLine("Workflow", KIND[menuOf.output], plural(menuOf.nodes, "node")) }}
            // the ··· holds everything but Try it, which is a button on every row: Edit is always there, whatever buttons the row shows
            items={fromMore ? cardItems(menuOf).slice(1) : cardItems(menuOf)}
            onClose={cardMenu.close}
          />
        )}

        <section className="flex flex-col gap-2">
          <SectionTitle>Your workflows{list.data ? ` · ${list.data.items.length}` : ""}</SectionTitle>
          {list.isPending ? (
            <Placeholder rows={3} tall />
          ) : list.isError && !list.data ? (
            <ErrorNote>Could not read your workflows: {list.error.message}</ErrorNote>
          ) : list.data?.items.length ? (
            <div className="overflow-hidden rounded-xl border border-line bg-panel">
              {list.data.items.map((w, i) => {
                const recipe = recipes.data?.recipes.find((r) => r.id === w.id);
                // a saved workflow that cannot be built says why; otherwise what the setup check says of its recipe
                const problem = w.problem ?? why(w.id);
                const status = setup.data?.recipes.find((r) => r.id === w.id);
                const pictures = recipe?.inputs.filter((x) => x.type === "image").length ?? 0;
                const controls = recipe?.inputs.filter((x) => x.advanced).length ?? 0;
                const menuHere = Boolean(cardMenu.menu && fromMore && menuOf?.id === w.id);
                // not ready: the fix comes first, and Try it stays (the form opens; Generate waits for the fix). Every row button is
                // quiet: coral is the page's one main action, Import
                const fix = comfyOnline || w.problem ? fixOf(status, w.problem) : null;
                return (
                  <div key={w.id} className={cx("flex flex-col gap-1.5 px-4 py-3", i > 0 && "border-t border-line")} onContextMenu={(e) => { setFromMore(false); cardMenu.open(e, w); }}>
                    <div className="grid grid-cols-[56px_minmax(0,1fr)_170px_184px] items-center gap-3.5">
                      {/* neutral: the kind is not a state, and the accent next to "Not ready" read as an error */}
                      <Chip className="justify-self-start">{KIND[w.output]}</Chip>
                      {/* the name opens the editor, as a file's name opens the file */}
                      <Link href={workflowEditHref(w.id)} className="group flex min-w-0 flex-col gap-0.5 rounded-md">
                        <span className="truncate font-semibold group-hover:underline">{recipeLabel(w.model, w.title)}</span>
                        <span className="truncate text-meta text-ink-3">
                          {w.source ? `${w.source} · ` : ""}{plural(w.nodes, "node")}{pictures ? ` · ${plural(pictures, "image input")}` : ""} · {plural(controls, "control")}
                        </span>
                      </Link>
                      <Readiness known={setup.isSuccess || Boolean(w.problem)} why={problem} get={w.problem ? null : toGet(status)} broken={Boolean(w.problem || status?.problems?.length)} />
                      <div className="flex items-center justify-end gap-1.5">
                        {fix && <Button size="sm" tone="quiet" onClick={() => editIt(w.id)} data-tip={fix.tip} className="whitespace-nowrap">{fix.label}</Button>}
                        <Button size="sm" tone="quiet" onClick={() => tryIt.mutate(w.id)} disabled={tryIt.isPending} data-tip={fix ? "Opens the form with this workflow picked, on a new draft. It renders once it is ready." : "Opens the form with this workflow picked, on a new draft."} className="whitespace-nowrap">Try it</Button>
                        {/* the fix opens the editor already: a second button for it would say the same */}
                        {!fix && <Button size="sm" tone="quiet" onClick={() => editIt(w.id)}>Edit</Button>}
                        <button
                          type="button"
                          aria-label={`More actions on ${w.title}`}
                          aria-haspopup="menu"
                          aria-expanded={menuHere}
                          data-tip="Edit, Export, Open in ComfyUI, Remove"
                          onClick={(e) => more(e, w)}
                          className={cx("flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink", menuHere && "bg-hover text-ink")}
                        >
                          <MoreHorizontal size={16} />
                        </button>
                      </div>
                    </div>
                    {opened?.id === w.id && !opened.direct && (
                      <div className="flex items-center gap-1.5 pl-[70px] text-xs text-ink-2">
                        Saved in ComfyUI as <span className="font-mono text-ink">{opened.path}</span>
                        <Help
                          title="Open it in ComfyUI"
                          text={`In ComfyUI, open the Workflows sidebar (key W) and pick it under "afflatus".${opened.restart
                            ? " Restart ComfyUI once: from then on it opens straight away."
                            : settings.data && !settings.data.comfyDir
                              ? " To have it open straight away, set the ComfyUI folder in Settings (same computer only)."
                              : ""}`}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            list.isSuccess && (
              <Empty
                title="No workflow of your own yet"
                helpTitle="Your workflows"
                help="A workflow you build in ComfyUI can be used here like any built-in model: Import ComfyUI workflow, above."
                action="Drop a .json, PNG or MP4 anywhere on this page"
              />
            )
          )}
        </section>

        <section className="flex flex-col gap-2">
          <SectionTitle>Built into Afflatus{recipes.data ? ` · ${builtIn.length}` : ""}</SectionTitle>
          {recipes.isPending ? (
            <Placeholder rows={4} />
          ) : (
            builtIn.length > 0 && (
              <div className="overflow-hidden rounded-xl border border-line bg-panel">
                {builtIn.map((f, i) => {
                  const mine = recipes.data?.recipes.filter((r) => r.family === f.id && !r.hidden) ?? [];
                  const slots = setup.data?.families.find((x) => x.id === f.id)?.slots ?? [];
                  const statuses = mine.map((r) => setup.data?.recipes.find((x) => x.id === r.id));
                  const status = familyStatus(statuses);
                  // one sentence for the family, every missing model file named once, as an imported workflow's are: said per
                  // operation, an edit model's operations repeated the base model's files after them
                  const said = setup.isSuccess ? notReady(status, comfyOnline, slots) : null;
                  // the model files of a built-in family are chosen and downloaded in Settings › Models
                  const fix = comfyOnline ? fixOf(status, undefined) : null;
                  return (
                    <div key={f.id} className={cx("grid grid-cols-[minmax(0,1fr)_110px_170px_184px] items-center gap-3.5 px-4 py-2.5", i > 0 && "border-t border-line")}>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate font-semibold">{f.name}</span>
                        <span className="truncate text-meta text-ink-3" data-tip={f.summary}>{f.summary}</span>
                      </div>
                      <span className="text-meta text-ink-2">{plural(mine.length, "operation")}</span>
                      <Readiness known={setup.isSuccess} why={said} get={toGet(status)} broken={Boolean(status?.problems?.length)} />
                      <div className="flex items-center justify-end">
                        {fix && said && (
                          <Button size="sm" tone="quiet" onClick={() => navigate(settingHref("models.families"))} data-tip={`Opens Settings › Models, where ${f.name}'s ${fix.label === "Get nodes" ? "node packs are listed" : "model files are chosen and downloaded"}`} className="whitespace-nowrap">{fix.label}</Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </section>
      </div>
    </div>
  );
}
