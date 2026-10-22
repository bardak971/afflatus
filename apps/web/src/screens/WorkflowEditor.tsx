import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ask } from "../Confirm";
import { releaseLeaveGuard, useLeaveGuard } from "../leaveGuard";
import { markPlace } from "../motion";
import { scrollInside } from "../scrollInside";
import { Button, Chip } from "../ui";
import { beforeItems } from "./workflowEditor/BeforeItRuns";
import { FormPanel } from "./workflowEditor/FormPanel";
import { ReadPanel } from "./workflowEditor/ReadPanel";
import { ShowPanel } from "./workflowEditor/ShowPanel";
import { useMapping, type Editing } from "./workflowEditor/useMapping";
import { queryKeys } from "../queryKeys";
import { plural } from "../format";

export type { Editing };

/**
 * The import screen, in three steps side by side: what Afflatus read (step 1, with what stands before a first
 * render), what the form shows (step 2), and the form itself (step 3). The state and every change to the mapping
 * are in useMapping; each step is its own panel.
 */
export function WorkflowEditor({ start, onDone }: { start: Editing; onDone(saved: boolean): void }) {
  const m = useMapping(start);
  const { b, graph, title, model, video } = m;
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () => {
      const body = { title: title.trim(), model: model.trim(), source: start.source, graph, wiring: m.wiring, editor: m.editor, bindings: b };
      return start.id ? api.saveWorkflow(start.id, body) : api.createWorkflow(body);
    },
    onSuccess: async () => {
      await Promise.all([queryKeys.recipes(), queryKeys.setup(), queryKeys.workflows()].map((queryKey) => client.invalidateQueries({ queryKey })));
      onDone(true);
    },
  });
  const canSave = title.trim() && model.trim() && !save.isPending;
  // the mapping lives only here: Cancel, another screen or closing the tab asks before throwing it away
  const discard = () => ask({ title: start.id ? "Discard your changes?" : "Discard this import?", text: "What you changed here is not saved.", yes: "Discard" });
  useLeaveGuard(m.dirty && !save.isPending, discard);
  const cancel = async () => {
    if (m.dirty && !(await discard())) return;
    // answered here: the way back to the list, an address of its own, is not asked again
    releaseLeaveGuard();
    onDone(false);
  };

  // the verdict: what was found, what was not, and what to see to before it runs
  const toCheck = beforeItems(m);
  const has = [
    b.model && "model file", b.prompt && "prompt", b.negative && "negative prompt", b.startImage && (video ? "first frame" : "image"), b.endImage && "last frame",
    b.sourceVideo && "source video", b.previousVideo && "previous clip", b.nextVideo && "next clip", b.sound && "sound",
    b.size && "resolution", video && b.length && "duration", b.seeds.length && "seed", b.loras.length && (b.loras.length > 1 ? `${b.loras.length} LoRA lists` : "LoRAs"),
    b.toggles.length && plural(b.toggles.length, "switch", "switches"), b.controls.length && plural(b.controls.length, "widget"),
    `${b.result.kind === "image" ? "image" : b.result.kind === "video" ? (b.result.sound ? "video with audio" : "video") : "audio"} output`,
  ].filter((x): x is string => Boolean(x));
  const lacks = [!b.prompt && "prompt", video && !b.startImage && "first frame", !b.seeds.length && "seed", !b.size && "resolution", video && !b.length && "duration"].filter((x): x is string => Boolean(x));

  const list = (items: string[]) => items.join(" · ");

  return (
    <div className="flex min-h-0 grow flex-col">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-8 py-2.5">
        <div className="flex min-w-0 flex-col">
          <h1 className="text-xl font-semibold">{start.id ? "Edit workflow" : "Import ComfyUI workflow"}</h1>
          <div className="truncate text-xs text-ink-2">{start.source || start.title} · {m.found.nodeCount} nodes</div>
        </div>
        <span className="grow" />
        {/* the verdict: three counts, each with its list in its tip; a click goes to where its items are in step 1 */}
        <Chip tone="good" tip={list(has)} onClick={() => jump('[data-jump="found"]')}>✓ {has.length} found<Mark items={has} /></Chip>
        {lacks.length > 0 && <Chip tone="neutral" tip={list(lacks)} onClick={() => jump("[data-jump] [data-dash]")}>– {lacks.length} not found<Mark items={lacks} /></Chip>}
        {toCheck.length > 0 && <Chip tone="warn" tip={list(toCheck)} onClick={() => jump('[data-jump="before"]')}>⚠ {toCheck.length} before it runs<Mark items={toCheck} /></Chip>}
        {/* said here only: the Model field's border marks it; a click goes there */}
        {!model.trim() && <Chip tone="warn" tip="Say which model it runs, in step 3's Model field." onClick={() => document.getElementById("wf-model")?.focus()}>Needs a model name to save</Chip>}
        <span className="mx-1 h-6 w-px bg-line" />
        <Button onClick={() => void cancel()}>Cancel</Button>
        <Button tone="primary" disabled={!canSave} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : start.id ? "Save changes" : "Save workflow"}</Button>
      </header>

      <div className="grid min-h-0 grow grid-cols-[400px_minmax(0,1fr)_440px]">
        <ReadPanel m={m} />
        <ShowPanel m={m} />
        <FormPanel m={m} saveError={save.error} />
      </div>
    </div>
  );
}

/** Says that a chip of the verdict has a list in its tip (and gives the list to screen readers). Not a button of its own: the chip is the button. */
function Mark({ items }: { items: string[] }) {
  return (
    <>
      <span aria-hidden className="ml-0.5 flex h-[15px] w-[15px] items-center justify-center rounded-full bg-hover text-[10px] font-bold text-ink-2">?</span>
      <span className="sr-only">: {items.join(", ")}</span>
    </>
  );
}

/** Brings a place of step 1 into view, moving only its column (never the page), and marks it for a moment. */
function jump(selector: string) {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return;
  scrollInside(el);
  markPlace(el, 1200);
}
