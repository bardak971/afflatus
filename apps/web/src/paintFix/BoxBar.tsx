import { useEffect, useRef, useState } from "react";
import { Settings2, Wand2 } from "lucide-react";
import type { RegionValue } from "@afflatus/core";
import { Kbd } from "../Keys";
import { tuneAt, useTune } from "../passTune";
import type { QueuedJob } from "../queueVariation";
import { Select } from "../Select";
import { plural } from "../format";
import { Button, Chip, cx, fieldClass, Help, IconButton } from "../ui";
import type { BoxEditor } from "./boxEditors";
import { FIX_ROWS, MASK_OR_BOX, useCtrlEnter } from "./FixBar";

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
export function BoxBar({ boxes, selected, onSelect, onPrompt, editors, editor, onEditor, job, busy, onEdit }: {
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
  onEdit(tuned: Record<string, unknown>): void;
}) {
  const box = boxInHand(boxes, selected);
  const n = box ? boxes.indexOf(box) + 1 : 0;
  // ⚙'s rows as last set: the next edit is sent with them too
  const [tuned, setTuned] = useState<Record<string, unknown>>({});
  const openTune = useTune((t) => t.open);
  const why = busy ? "Sending…" : boxesWhy(boxes);
  const go = (more: Record<string, unknown> = {}) => {
    if (!why) onEdit({ ...tuned, ...more });
  };
  const root = useRef<HTMLDivElement>(null);
  useCtrlEnter(go, root);
  // the model is the select's beside it: the button says what it does and how many boxes
  const words = `Edit in box · ${plural(boxes.length, "box", "boxes")}`;
  const tune = (gear: Element) =>
    openTune(tuneAt(gear), {
      action: "edit",
      title: "Edit in box",
      sub: `${editor.name}, ${boxes.length === 1 ? "one box" : `${boxes.length} boxes one after another`}`,
      rows: FIX_ROWS,
      go: words,
      job: { ...job, stored: { ...job.stored, ...tuned } },
      queue: (changed) => {
        setTuned((t) => ({ ...t, ...changed }));
        go(changed);
      },
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
    <div ref={root} className="flex w-full max-w-[1040px] shrink-0 flex-col items-center gap-1.5">
      {/* on a narrow stage the instruction keeps a row of its own, the model and the button wrapping under it */}
      <div role="group" aria-label="Edit in box" className="flex w-full flex-wrap items-center justify-end gap-2">
        <Chip
          tone="accent"
          tip={boxes.length > 1 ? "The box the instruction is for: click for the next one (or pick a box on the picture)" : "The box the instruction is for"}
          onClick={boxes.length > 1 && box ? () => onSelect(boxes[n % boxes.length]!.id) : undefined}
        >
          Box {n} of {boxes.length}
        </Chip>
        <input
          ref={field}
          aria-label={`What to do in box ${n}`}
          value={box?.prompt ?? ""}
          placeholder={`What to do in box ${n}: "a deer drinking at the stream"`}
          data-tip="The instruction for this box alone: what to add, change or remove there. The rest of the picture is kept"
          onChange={(e) => box && onPrompt(box.id, e.target.value)}
          onKeyDown={(e) => {
            // the layer's keys (B, V, Del…) are not the field's: it keeps every key typed in it
            e.stopPropagation();
            if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              // Enter on a box with more to say steps to the next one; on the last, it edits
              const next = boxes.find((b, i) => i >= n && !b.prompt.trim()) ?? boxes.find((b) => !b.prompt.trim());
              if (next && next.id !== box?.id) onSelect(next.id);
              else go();
            }
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          className={cx(fieldClass, "h-9 min-w-60 grow basis-60")}
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
        <IconButton label="The edit's settings" tip="Steps, CFG, sampler, scheduler" tone="outline" size={32} onClick={(e) => tune(e.currentTarget)}>
          <Settings2 size={15} />
        </IconButton>
        <Button tone="primary" disabled={Boolean(why)} data-tip={why ?? "Each box edited from its own instruction, one after another, into one version of the picture"} onClick={() => go()} className="h-9 shrink-0">
          <Wand2 size={14} /> {words} <Kbd>Ctrl+Enter</Kbd>
        </Button>
      </div>
      {!editor.ready && <span className="text-xs font-semibold text-attention-ink">{editor.name}'s files are not all in ComfyUI: Settings › Models has them, or a pod fetches them</span>}
      <span className="flex flex-wrap items-center justify-center gap-x-1 text-xs text-ink-3">
        Each box its own instruction, done one after another into one version · <Kbd>Del</Kbd> removes the box picked · paint a part to fix it instead · <Kbd>Esc</Kbd> leaves Paint and fix
        <Help title="Mask or box" text={MASK_OR_BOX} />
      </span>
    </div>
  );
}
