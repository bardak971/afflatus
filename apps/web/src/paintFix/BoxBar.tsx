import { useEffect, useRef } from "react";
import { Settings2, Wand2 } from "lucide-react";
import type { RegionValue } from "@afflatus/core";
import { Kbd } from "../Keys";
import type { QueuedJob } from "../queueVariation";
import { Select } from "../Select";
import { plural } from "../format";
import { Button, Failed, Help, IconButton } from "../ui";
import type { BoxEditor } from "./boxEditors";
import { BAR_CAPSULE, BarInput, BarWhat, FIX_ROWS, GoKeys, MASK_OR_BOX, useTunedBar, type BarFailure } from "./FixBar";

/** The box whose instruction the bar's field holds: the one picked, else the first that says nothing yet, else the last drawn. */
export function boxInHand(boxes: readonly RegionValue[], selected: string | null): RegionValue | undefined {
  return boxes.find((b) => b.id === selected) ?? boxes.find((b) => !b.prompt.trim()) ?? boxes.at(-1);
}

/** Why the boxes cannot be sent yet, or null: every box says what to do there. */
export function boxesWhy(boxes: readonly RegionValue[]): string | null {
  const unsaid = boxes.findIndex((b) => !b.prompt.trim());
  return unsaid >= 0 ? `Box ${unsaid + 1} says nothing to do yet` : null;
}

/**
 * Paint and fix's bar while boxes are drawn and nothing is painted (card #284): the box in hand (its chip steps to the next),
 * what to do in it, the editor (the picture's own model's, else Settings' one, another for this edit), ⚙ for its sampling,
 * and Edit in box. Each box keeps its own instruction; they are done one after another into one version of the picture.
 */
export function BoxBar({ boxes, selected, onSelect, onPrompt, editors, editor, onEditor, job, busy, failure, onEdit }: {
  boxes: RegionValue[];
  selected: string | null;
  onSelect(id: string): void;
  onPrompt(id: string, prompt: string): void;
  editors: BoxEditor[];
  editor: BoxEditor;
  onEditor(family: string): void;
  /** The job as Edit in box would queue it, for ⚙'s rows to start on. */
  job: QueuedJob;
  busy: boolean;
  /** Why the last Edit in box failed to queue: said under the bar until the next try. */
  failure?: BarFailure | null;
  onEdit(tuned: Record<string, unknown>): void;
}) {
  const box = boxInHand(boxes, selected);
  const n = box ? boxes.indexOf(box) + 1 : 0;
  const why = busy ? "Sending…" : boxesWhy(boxes);
  const bar = useTunedBar((tuned) => {
    if (!why) onEdit(tuned);
  });
  const go = () => bar.go();
  // the model is the select's beside it: the button says what it does and how many boxes
  const words = `Edit in box · ${plural(boxes.length, "box", "boxes")}`;
  const tune = (gear: Element) =>
    bar.tune(gear, {
      action: "edit",
      title: "Edit in box",
      sub: `${editor.name}, ${boxes.length === 1 ? "one box" : `${boxes.length} boxes one after another`}`,
      rows: FIX_ROWS,
      go: words,
      job,
    });
  // a box just drawn is said what to do at once: the field takes the keys (the bar comes with the first box drawn, so it
  // counts from none)
  const field = useRef<HTMLInputElement>(null);
  const drawn = useRef(0);
  useEffect(() => {
    if (boxes.length > drawn.current) field.current?.focus();
    drawn.current = boxes.length;
  }, [boxes.length]);
  return (
    <div ref={bar.root} className="flex w-full max-w-[940px] shrink-0 flex-col items-center gap-1.5">
      {/* on a narrow stage the instruction keeps a row of its own, the model and the button wrapping under it */}
      <div role="group" aria-label="Edit in box" className={BAR_CAPSULE}>
        <BarWhat tone="box" tip={boxes.length > 1 ? "The box the instruction is for: ‹ › for the one before or after (or pick a box on the picture)" : "The box the instruction is for"}>
          {boxes.length > 1 && box && <button type="button" data-soft-focus aria-label="The box before" className="px-0.5 font-semibold text-ink-3 hover:text-ink" onClick={() => onSelect(boxes[(n - 2 + boxes.length) % boxes.length]!.id)}>‹</button>}
          <span>✦ Box {n} of {boxes.length}</span>
          {boxes.length > 1 && box && <button type="button" data-soft-focus aria-label="The box after" className="px-0.5 font-semibold text-ink-3 hover:text-ink" onClick={() => onSelect(boxes[n % boxes.length]!.id)}>›</button>}
        </BarWhat>
        <BarInput
          ref={field}
          aria-label={`What to do in box ${n}`}
          value={box?.prompt ?? ""}
          placeholder={`What to do in box ${n}: "a deer drinking at the stream"`}
          data-tip="The instruction for this box alone: what to add, change or remove there. The rest of the picture is kept"
          onChange={(e) => box && onPrompt(box.id, e.target.value)}
          onEnter={() => {
            // Enter on a box with more to say steps to the next one; on the last, it edits
            const next = boxes.find((b, i) => i >= n && !b.prompt.trim()) ?? boxes.find((b) => !b.prompt.trim());
            if (next && next.id !== box?.id) onSelect(next.id);
            else go();
          }}
        />
        <Select
          label="Edit model for the boxes"
          size="sm"
          value={editor.family}
          options={editors.map((e) => ({ value: e.family, label: e.name, ...(e.ready ? {} : { note: "files missing", muted: true }) }))}
          onChange={onEditor}
          // Select is full width by its own class: the width wins only with !
          className="w-44! shrink-0"
        />
        <IconButton label="The edit's settings" tip="Steps, CFG, sampler, scheduler" size={32} data-soft-focus onClick={(e) => tune(e.currentTarget)}>
          <Settings2 size={15} />
        </IconButton>
        <Button tone="primary" disabled={Boolean(why)} data-tip={why ?? "Each box edited from its own instruction, one after another, into one version of the picture"} data-tip-keys="Ctrl+Enter" onClick={() => go()} data-soft-focus className="h-8 shrink-0 bg-picture! text-ground! hover:brightness-110">
          <Wand2 size={14} /> {words} <GoKeys />
        </Button>
      </div>
      {failure && <Failed inline what={failure.what} error={failure.error} />}
      {!editor.ready && <span className="text-xs font-semibold text-attention-ink">{editor.name}'s files are not all in ComfyUI: Settings › Models has them, or a pod fetches them</span>}
      <span className="flex flex-wrap items-center justify-center gap-x-1 text-xs text-ink-3">
        Each box its own instruction, done one after another into one version · <Kbd>Del</Kbd> removes the box picked · paint a part to fix it instead · <Kbd>Esc</Kbd> lets go of the box picked, again leaves Paint and fix
        <Help title="Mask or box" text={MASK_OR_BOX} />
      </span>
    </div>
  );
}
