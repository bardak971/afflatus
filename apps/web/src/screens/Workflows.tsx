import { useEffect, useRef, useState, type DragEvent } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { bindings as bindingsSchema, type Bindings } from "@studai/workflows";
import { api, ApiError, type WorkflowBrief } from "../api";
import { useRecipes, useSetup, useWorkflows } from "../data";
import { notReady, recipeLabel } from "../format";
import { useHandover, useOpenDraft } from "../store";
import { Button, cx, ErrorNote, SectionTitle } from "../ui";
import { WorkflowEditor, type Editing } from "./WorkflowEditor";

/**
 * Read a file the user chose: a workflow as ComfyUI saves it, one saved with "Export (API)", or one
 * shared from another studai (the same workflow with its mapping already made).
 */
async function readFile(file: File): Promise<Editing> {
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new ApiError("This file could not be read. A workflow is a .json file.");
  }
  const shared = json && typeof json === "object" && "graph" in json && "bindings" in json ? (json as { graph: unknown; wiring?: unknown; bindings: unknown; title?: unknown; model?: unknown }) : null;
  // the server answers with the workflow in the form studai keeps, whatever form the file was in
  const inspection = await api.inspectWorkflow(shared ? { graph: shared.graph, wiring: shared.wiring } : json);
  let bindings: Bindings | null = inspection.suggested;
  if (shared) {
    const parsed = bindingsSchema.safeParse(shared.bindings);
    if (!parsed.success) throw new ApiError("This looks like a workflow shared from studai, but its settings could not be read.");
    bindings = parsed.data;
  }
  if (!bindings) throw new ApiError("This workflow saves nothing: it has no node that saves or shows a picture, a video or a sound.");
  return {
    id: null,
    source: file.name,
    title: typeof shared?.title === "string" ? shared.title : file.name.replace(/\.json$/i, "").replace(/\s*\(API\)$/i, ""),
    model: typeof shared?.model === "string" ? shared.model : "",
    graph: inspection.graph,
    wiring: inspection.wiring,
    inspection,
    bindings,
  };
}

/** A saved workflow, opened again to change its mapping. */
async function reopen(id: string): Promise<Editing> {
  const def = await api.workflow(id);
  const inspection = await api.inspectWorkflow({ graph: def.graph, wiring: def.wiring });
  return { id: def.id, source: def.source, title: def.title, model: def.model, graph: def.graph, wiring: def.wiring, inspection, bindings: def.bindings };
}

/** The workflow with its mapping, as a file someone else can import into their studai. */
async function share(w: WorkflowBrief): Promise<void> {
  const { id: _id, ...def } = await api.workflow(w.id);
  const url = URL.createObjectURL(new Blob([JSON.stringify(def, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${w.title.replace(/[^\w .-]+/g, "").trim() || "workflow"}.studai.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const KIND = { image: "Picture", video: "Video", audio: "Sound" } as const;

export function Workflows() {
  const list = useWorkflows();
  const recipes = useRecipes();
  const setup = useSetup();
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
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
  const [, go] = useLocation();
  const openDraft = useOpenDraft((s) => s.open);
  // straight to the form on a new draft with the workflow picked: nothing is rendered until Generate is pressed
  const tryIt = useMutation({
    mutationFn: (workflow: string) => {
      const recipe = recipes.data?.recipes.find((r) => r.id === workflow);
      if (!recipe) throw new Error("This workflow is not in the list of things to create yet. Reload the page.");
      return api.createDraft({ recipe: recipe.id });
    },
    onSuccess: (d) => {
      client.setQueryData(["drafts", d.id], d);
      void client.invalidateQueries({ queryKey: ["drafts"], exact: true });
      openDraft(d.id);
      go("/create");
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteWorkflow,
    onSuccess: () => Promise.all(["recipes", "setup", "workflows"].map((key) => client.invalidateQueries({ queryKey: [key] }))),
  });

  if (editing) return <WorkflowEditor key={`${editing.id}:${editing.source}`} start={editing} onDone={() => setEditing(null)} />;

  const comfyOnline = setup.data?.comfy.online ?? false;
  const why = (recipeId: string) => (setup.isSuccess ? notReady(setup.data.recipes.find((r) => r.id === recipeId), comfyOnline) : null);
  const builtIn = (recipes.data?.families ?? []).filter((f) => !f.id.startsWith("workflow-"));
  const error = open.error ?? edit.error ?? shareIt.error ?? tryIt.error ?? remove.error ?? list.error;

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
          <div className="text-ink-2">Everything studai can make pictures and videos with. Each one appears under "Made with" in Studio's form.</div>
        </div>
        <span className="grow" />
        <Button tone="primary" onClick={() => input.current?.click()} disabled={open.isPending}>
          <FileUp size={15} /> {open.isPending ? "Reading…" : "Import a ComfyUI workflow"}
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
          {list.data?.items.map((w) => {
            const recipe = recipes.data?.recipes.find((r) => r.id === w.id);
            const problem = why(w.id);
            const pictures = recipe?.inputs.filter((i) => i.type === "image").length ?? 0;
            const controls = recipe?.inputs.filter((i) => i.advanced).length ?? 0;
            return (
              <div key={w.id} className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className={cx("shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold", w.output === "video" ? "bg-accent-wash text-accent" : "bg-raised text-picture")}>{KIND[w.output]}</span>
                  <div className="flex min-w-0 grow flex-col">
                    <span className="truncate text-[15px] font-semibold">{recipeLabel(w.model, w.title)}</span>
                    <span className="truncate text-xs text-ink-2">
                      {w.source ? `from ${w.source} · ` : ""}{w.nodes} nodes{pictures ? ` · takes ${pictures} picture${pictures > 1 ? "s" : ""}` : ""} · {controls} control{controls === 1 ? "" : "s"}
                    </span>
                  </div>
                  <span className={cx("shrink-0 font-semibold", problem ? "text-warn-ink" : "text-good")}>{setup.isSuccess ? (problem ? "Not ready" : "Ready") : ""}</span>
                </div>
                {problem && <div className="text-warn-ink">{problem}</div>}
                <div className="flex flex-wrap items-center gap-1.5">
                  {removing === w.id ? (
                    <>
                      <span className="text-xs text-ink-2">What you made with it stays in your library.</span>
                      <Button size="sm" tone="danger" onClick={() => { remove.mutate(w.id); setRemoving(null); }}>Remove</Button>
                      <Button size="sm" onClick={() => setRemoving(null)}>Cancel</Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" tone="quiet" onClick={() => tryIt.mutate(w.id)} disabled={tryIt.isPending} title="Opens the form with this workflow picked, on a new draft.">Try it</Button>
                      <Button size="sm" onClick={() => edit.mutate(w.id)} disabled={edit.isPending}>Change</Button>
                      <Button size="sm" onClick={() => shareIt.mutate(w)}>Share as a file</Button>
                      <Button size="sm" onClick={() => setRemoving(w.id)}>Remove</Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {list.isSuccess && !list.data.items.length && (
            <div className="rounded-xl border border-line bg-panel px-4 py-3 text-ink-2">None yet. A workflow you build in ComfyUI can be used here like any built-in model.</div>
          )}

          <div className="pt-3"><SectionTitle>Built into studai · {builtIn.length}</SectionTitle></div>
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
                {problems[0] && <span className="text-warn-ink">{problems[0]} <Link href="/settings" className="font-semibold underline">Open Settings</Link></span>}
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
            <h2 className="text-[15px] font-bold">How to bring a workflow from ComfyUI</h2>
            {[
              "Build it and check it works in ComfyUI, as usual.",
              "Find its file: ComfyUI keeps the workflows you save in its user/default/workflows folder. A file saved with Workflow, then \"Export (API)\", works too.",
              "Drop the file here. studai shows which parts it found (the description, the pictures, the result, the switches) and you correct what is wrong.",
            ].map((step, i) => (
              <div key={step} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-hover text-xs font-bold">{i + 1}</span>
                <span className="text-ink-2">{step}</span>
              </div>
            ))}
            <div className="text-xs text-ink-3">
              Prefer the file ComfyUI saves: it keeps the parts that are switched off, so they become switches here. An exported file only has what was switched on.
            </div>
            <div className="text-xs text-ink-3">You can also import a workflow someone shared from their studai.</div>
          </div>
        </aside>
      </div>
    </div>
  );
}
