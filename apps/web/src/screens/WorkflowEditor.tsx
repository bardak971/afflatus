import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button } from "../ui";
import { FormPanel } from "./workflowEditor/FormPanel";
import { Chip } from "./workflowEditor/parts";
import { ReadPanel } from "./workflowEditor/ReadPanel";
import { ShowPanel } from "./workflowEditor/ShowPanel";
import { useMapping, type Editing } from "./workflowEditor/useMapping";

export type { Editing };

/**
 * The import screen, in three steps side by side: what Afflatus read (step 1, with what stands before a first
 * render), what the form shows (step 2), and the form itself (step 3). The state and every change to the mapping
 * are in useMapping; each step is its own panel.
 */
export function WorkflowEditor({ start, onDone }: { start: Editing; onDone(saved: boolean): void }) {
  const m = useMapping(start);
  const { found, b, graph, title, model, video, looseNotes } = m;
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () => {
      const body = { title: title.trim(), model: model.trim(), source: start.source, graph, wiring: m.wiring, editor: start.editor, bindings: b };
      return start.id ? api.saveWorkflow(start.id, body) : api.createWorkflow(body);
    },
    onSuccess: async () => {
      await Promise.all(["recipes", "setup", "workflows"].map((key) => client.invalidateQueries({ queryKey: [key] })));
      onDone(true);
    },
  });
  const canSave = title.trim() && model.trim() && !save.isPending;

  // the verdict: what was found, what was not, and what to see to before it runs
  const unreplacedFiles = found.missingFiles.filter((f) => String(graph[f.node]?.inputs[f.input] ?? f.file) === f.file);
  const unreplacedChoices = (found.missingChoices ?? []).filter((c) => String(graph[c.node]?.inputs[c.input] ?? c.value) === c.value);
  const toCheck = (found.missingNodes.length ? 1 : 0) + unreplacedFiles.length + unreplacedChoices.length + looseNotes.length;
  const has = [
    b.model && "model file", b.prompt && "prompt", b.negative && "negative prompt", b.startImage && (video ? "first frame" : "image"), b.endImage && "last frame",
    b.sourceVideo && "source video", b.previousVideo && "previous clip", b.nextVideo && "next clip", b.sound && "sound",
    b.size && "resolution", video && b.length && "duration", b.seeds.length && "seed", b.loras.length && (b.loras.length > 1 ? `${b.loras.length} LoRA lists` : "LoRAs"),
    b.toggles.length && `${b.toggles.length} switch${b.toggles.length === 1 ? "" : "es"}`, b.controls.length && `${b.controls.length} widget${b.controls.length === 1 ? "" : "s"}`,
    `${b.result.kind === "image" ? "image" : b.result.kind === "video" ? (b.result.sound ? "video with audio" : "video") : "audio"} output`,
  ].filter((x): x is string => Boolean(x));
  const lacks = [!b.prompt && "prompt", video && !b.startImage && "first frame", !b.seeds.length && "seed", !b.size && "resolution", video && !b.length && "duration"].filter((x): x is string => Boolean(x));

  return (
    <div className="flex min-h-0 grow flex-col">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line px-8">
        <div className="flex min-w-0 flex-col">
          <h1 className="text-xl font-semibold">{start.id ? "Edit workflow" : "Import ComfyUI workflow"}</h1>
          <div className="truncate text-xs text-ink-2">{start.source || start.title} · {found.nodeCount} nodes</div>
        </div>
        <span className="grow" />
        <Button onClick={() => onDone(false)}>Cancel</Button>
        <Button tone="primary" disabled={!canSave} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : start.id ? "Save changes" : "Save workflow"}</Button>
      </header>
      {/* the verdict: one line that says where things stand */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-8 py-2">
        <Chip tone="good">Found: {has.join(", ")}</Chip>
        {lacks.length > 0 && <Chip tone="plain">Not found: {lacks.join(", ")}</Chip>}
        {toCheck > 0 ? <Chip tone="warn">{toCheck} thing{toCheck === 1 ? "" : "s"} to see to before it runs</Chip> : <Chip tone="good">Everything it needs is in your ComfyUI</Chip>}
        {!model.trim() && <Chip tone="warn">Needs a model name to save</Chip>}
      </div>

      <div className="grid min-h-0 grow grid-cols-[minmax(0,1fr)_minmax(0,1fr)_460px]">
        <ReadPanel m={m} />
        <ShowPanel m={m} />
        <FormPanel m={m} saveError={save.error} />
      </div>
    </div>
  );
}
