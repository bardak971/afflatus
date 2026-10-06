import { useEffect, useRef, useState, type DragEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, FileUp, Pencil, Play, Trash2 } from "lucide-react";
import { ContextMenu, useMenu, type MenuItem } from "../ContextMenu";
import { ask } from "../Confirm";
import { bindings as bindingsSchema, guessModel, type Bindings } from "@afflatus/workflows";
import { useOpenInComfy } from "../actions";
import { api, ApiError, type WorkflowBrief } from "../api";
import { useRecipes, useSettings, useSetup, useWorkflows } from "../data";
import { useOpenNewDraft } from "../draft";
import { notReady, recipeLabel } from "../format";
import { useHandover } from "../store";
import { Button, cx, ErrorNote, SectionTitle, TwoStep } from "../ui";
import { WorkflowEditor, type Editing } from "./WorkflowEditor";

/**
 * Read a file the user chose: a workflow as ComfyUI saves it, one saved with "Export (API)", or one
 * shared from another Afflatus (the same workflow with its mapping already made).
 */
async function readFile(file: File): Promise<Editing> {
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new ApiError("This file could not be parsed. A workflow is a .json file.");
  }
  const shared = json && typeof json === "object" && "graph" in json && "bindings" in json ? (json as { graph: unknown; wiring?: unknown; bindings: unknown; title?: unknown; model?: unknown }) : null;
  // the server answers with the workflow in the form Afflatus keeps, whatever form the file was in
  const inspection = await api.inspectWorkflow(shared ? { graph: shared.graph, wiring: shared.wiring } : json);
  let bindings: Bindings | null = inspection.suggested;
  if (shared) {
    const parsed = bindingsSchema.safeParse(shared.bindings);
    if (!parsed.success) throw new ApiError("This looks like a workflow shared from Afflatus, but its bindings could not be read.");
    bindings = parsed.data;
  }
  if (!bindings) {
    // a save node of a pack this ComfyUI lacks is not known to be an output: the missing nodes are the news, not the output
    const missing = inspection.missingNodes ?? [];
    if (missing.length) {
      const packs = [...new Set(Object.values(inspection.packs ?? {}))];
      const some = missing.slice(0, 4).join(", ") + (missing.length > 4 ? ` and ${missing.length - 4} more` : "");
      throw new ApiError(`This ComfyUI is missing ${missing.length} node type${missing.length > 1 ? "s" : ""} this workflow uses (${some})${packs.length ? `, from ${packs.join(", ")}` : ""}. Install ${packs.length > 1 ? "those packs" : "the pack"} in ComfyUI (ComfyUI-Manager's "Install missing custom nodes" takes them from the workflow), restart it, then import again.`);
    }
    throw new ApiError("This workflow has no output: no Save or Preview node for an image, a video or audio.");
  }
  return {
    id: null,
    source: file.name,
    title: typeof shared?.title === "string" ? shared.title : file.name.replace(/\.json$/i, "").replace(/\s*\(API\)$/i, ""),
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

/** The workflow with its mapping, as a file someone else can import into their Afflatus. */
async function share(w: WorkflowBrief): Promise<void> {
  const { id: _id, ...def } = await api.workflow(w.id);
  const url = URL.createObjectURL(new Blob([JSON.stringify(def, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${w.title.replace(/[^\w .-]+/g, "").trim() || "workflow"}.afflatus.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const KIND = { image: "Image", video: "Video", audio: "Audio" } as const;

export function Workflows() {
  const list = useWorkflows();
  const recipes = useRecipes();
  const setup = useSetup();
  const settings = useSettings();
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [over, setOver] = useState(false);

  const open = useMutation({ mutationFn: readFile, onSuccess: setEditing });
  const edit = useMutation({ mutationFn: reopen, onSuccess: setEditing });
  // a workflow taken out of a picture or a video that was dropped on the app
  const handed = useHandover((h) => h.workflow);
  const hand = useHandover((h) => h.set);
  useEffect(() => {
    if (!handed) return;
    hand({ workflow: null });
    open.mutate(handed);
  }, [handed]); // eslint-disable-line react-hooks/exhaustive-deps
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
    { label: "Try it", icon: <Play size={14} />, note: "the form, on a new draft", disabled: tryIt.isPending, run: () => tryIt.mutate(w.id) },
    { label: "Edit", icon: <Pencil size={14} />, note: "its mapping and form", disabled: edit.isPending, run: () => edit.mutate(w.id) },
    "—",
    { label: "Export", icon: <Download size={14} />, note: "a file another Afflatus imports", run: () => shareIt.mutate(w) },
    { label: "Open in ComfyUI", icon: <ExternalLink size={14} />, disabled: openInComfy.isPending || !comfyOnline, note: comfyOnline ? undefined : "ComfyUI is not running", run: () => openInComfy.mutate(w) },
    "—",
    { label: "Remove", icon: <Trash2 size={14} />, danger: true, note: "what it made stays in the library", run: () => void ask({ title: `Remove ${w.title}?`, text: "What you generated with it stays in your library.", yes: "Remove" }).then((yes) => yes && remove.mutate(w.id)) },
  ];
  const remove = useMutation({
    mutationFn: api.deleteWorkflow,
    onSuccess: () => Promise.all(["recipes", "setup", "workflows"].map((key) => client.invalidateQueries({ queryKey: [key] }))),
  });

  if (editing) return <WorkflowEditor key={`${editing.id}:${editing.source}`} start={editing} onDone={() => setEditing(null)} />;

  const comfyOnline = setup.data?.comfy.online ?? false;
  const why = (recipeId: string) => (setup.isSuccess ? notReady(setup.data.recipes.find((r) => r.id === recipeId), comfyOnline) : null);
  const builtIn = (recipes.data?.families ?? []).filter((f) => !f.id.startsWith("workflow-"));
  const error = open.error ?? edit.error ?? shareIt.error ?? tryIt.error ?? remove.error ?? openInComfy.error ?? list.error;

  const drop = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      const file = e.dataTransfer.files[0];
      if (file) open.mutate(file);
    },
  };

  return (
    <div className="flex min-h-0 grow flex-col overflow-y-auto px-8 pb-8">
      <header className="flex h-20 shrink-0 items-center gap-4">
        <div className="flex flex-col">
          <h1 className="text-xl font-semibold">Models and workflows</h1>
          <div className="text-ink-2">Everything Afflatus can generate images and videos with. Each one appears under "Model" in Studio's form.</div>
        </div>
        <span className="grow" />
        <Button tone="primary" onClick={() => input.current?.click()} disabled={open.isPending}>
          <FileUp size={15} /> {open.isPending ? "Reading…" : "Import ComfyUI workflow"}
        </Button>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) open.mutate(f);
            e.target.value = "";
          }}
        />
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-5">
        <div className="flex flex-col gap-2.5">
          {error && <ErrorNote>{error.message}</ErrorNote>}

          <SectionTitle>Your workflows · {list.data?.items.length ?? 0}</SectionTitle>
          {cardMenu.menu && <ContextMenu at={cardMenu.menu.at} label={`Actions on ${cardMenu.menu.subject.title}`} items={cardItems(cardMenu.menu.subject)} onClose={cardMenu.close} />}
          {list.data?.items.map((w) => {
            const recipe = recipes.data?.recipes.find((r) => r.id === w.id);
            const problem = why(w.id);
            const pictures = recipe?.inputs.filter((i) => i.type === "image").length ?? 0;
            const controls = recipe?.inputs.filter((i) => i.advanced).length ?? 0;
            return (
              <div key={w.id} className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-4 py-3" onContextMenu={(e) => cardMenu.open(e, w)}>
                <div className="flex items-center gap-3">
                  <span className={cx("shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold", w.output === "video" ? "bg-accent-wash text-accent" : "bg-raised text-picture")}>{KIND[w.output]}</span>
                  <div className="flex min-w-0 grow flex-col">
                    <span className="truncate text-[15px] font-semibold">{recipeLabel(w.model, w.title)}</span>
                    <span className="truncate text-xs text-ink-2">
                      {w.source ? `from ${w.source} · ` : ""}{w.nodes} nodes{pictures ? ` · ${pictures} image input${pictures > 1 ? "s" : ""}` : ""} · {controls} control{controls === 1 ? "" : "s"}
                    </span>
                  </div>
                  <span className={cx("shrink-0 font-semibold", problem ? "text-warn-ink" : "text-good")}>{setup.isSuccess ? (problem ? "Not ready" : "Ready") : ""}</span>
                </div>
                {problem && <div className="text-warn-ink">{problem}</div>}
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button size="sm" tone="quiet" onClick={() => tryIt.mutate(w.id)} disabled={tryIt.isPending} title="Opens the form with this workflow picked, on a new draft.">Try it</Button>
                  <Button size="sm" onClick={() => edit.mutate(w.id)} disabled={edit.isPending}>Edit</Button>
                  <Button size="sm" onClick={() => shareIt.mutate(w)}>Export</Button>
                  <Button size="sm" onClick={() => openInComfy.mutate(w)} disabled={openInComfy.isPending || !comfyOnline} title={comfyOnline ? "Writes the workflow into ComfyUI's workflows folder and opens ComfyUI: pick it in the Workflows sidebar." : "ComfyUI is not running."}>Open in ComfyUI</Button>
                  <TwoStep label="Remove" title={`Remove ${w.title}`} note="What you generated with it stays in your library." yes="Remove" onYes={() => remove.mutate(w.id)} />
                </div>
                {opened?.id === w.id && !opened.direct && (
                  <div className="text-xs text-ink-2">
                    Saved in ComfyUI as <span className="font-mono text-ink">{opened.path}</span>: in ComfyUI, open the Workflows sidebar (key W) and pick it under "afflatus".
                    {opened.restart
                      ? " Restart ComfyUI once: from then on it opens straight away."
                      : settings.data && !settings.data.comfyDir
                        ? " To have it open straight away, set the ComfyUI folder in Settings (same computer only)."
                        : ""}
                  </div>
                )}
              </div>
            );
          })}
          {list.isSuccess && !list.data.items.length && (
            <div className="rounded-xl border border-line bg-panel px-4 py-3 text-ink-2">None yet. A workflow you build in ComfyUI can be used here like any built-in model.</div>
          )}

          <div className="pt-3"><SectionTitle>Built into Afflatus · {builtIn.length}</SectionTitle></div>
          {builtIn.map((f) => {
            const mine = recipes.data?.recipes.filter((r) => r.family === f.id) ?? [];
            const problems = mine.map((r) => why(r.id)).filter(Boolean);
            return (
              <div key={f.id} className="flex flex-col gap-1 rounded-xl border border-line bg-panel px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[15px] font-semibold">{f.name}</span>
                  <span className={cx("shrink-0 font-semibold", problems.length ? "text-warn-ink" : "text-good")}>{setup.isSuccess ? (problems.length ? "Not ready" : "Ready") : ""}</span>
                </div>
                <span className="text-ink-2">{f.summary}</span>
                {problems[0] && <span className="text-warn-ink">{problems[0]} <Link href="/settings/models" className="font-semibold underline">Open Settings</Link></span>}
              </div>
            );
          })}
        </div>

        <aside className="flex flex-col gap-4">
          <button
            type="button"
            {...drop}
            onClick={() => input.current?.click()}
            className={cx(
              "flex flex-col items-center gap-1.5 rounded-2xl border-2 border-dashed px-6 py-10 text-center",
              over ? "border-accent bg-accent-wash" : "border-line-strong hover:border-ink-3",
            )}
          >
            <FileUp size={22} className="text-ink-2" />
            <span className="text-base font-semibold">Drop a workflow file here</span>
            <span className="text-ink-2">or click to choose one from your computer</span>
          </button>

          <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
            <h2 className="text-[15px] font-bold">How to import a workflow from ComfyUI</h2>
            {[
              "Build it and check it works in ComfyUI, as usual.",
              "Find its file: ComfyUI keeps the workflows you save in its user/default/workflows folder. A file saved with Workflow, then \"Export (API)\", works too.",
              "Drop the file here. Afflatus shows which parts it found (the prompt, the image inputs, the output, the bypass switches) and you correct what is wrong.",
            ].map((step, i) => (
              <div key={step} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-hover text-xs font-bold">{i + 1}</span>
                <span className="text-ink-2">{step}</span>
              </div>
            ))}
            <div className="text-xs text-ink-3">
              Prefer the file ComfyUI saves: it keeps the bypassed and muted nodes, so they become switches here. An API export only has what was active.
            </div>
            <div className="text-xs text-ink-3">You can also import a workflow someone shared from their Afflatus.</div>
          </div>
        </aside>
      </div>
    </div>
  );
}
