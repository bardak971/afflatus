import { useEffect, useRef, useState, type InputHTMLAttributes, type Ref, type RefObject } from "react";
import { Settings2, Wand2 } from "lucide-react";
import type { InputSpec } from "@afflatus/core";
import type { RecipeInfo } from "../api";
import { plural } from "../format";
import { dialogOver, OVER } from "../Dialog";
import { Kbd } from "../Keys";
import { MAX_COUNT, tuneAt, useTune, type TuneAsk } from "../passTune";
import type { QueuedJob } from "../queueVariation";
import { Button, Chip, cx, Failed, fieldClass, Help, IconButton, NumberBox } from "../ui";
import type { FixAsk } from "./useFixJob";

/**
 * The fix's settings in ⚙: the sampling, and an outpaint's feathering. Short, so the popover leaves the picture in sight.
 * The prompt, denoise and grow are on the bar and the strip; the mask's soft edge is the layer's Feather, so the recipe's
 * Mask blur is not offered twice; it and the negative prompt stay in the full form.
 */
export const FIX_ROWS = ["feathering", "steps", "cfg", "sampler", "scheduler"] as const;

/** How many versions a Fix makes when nothing else was asked (the mock's ×3). */
const FIX_COUNT = 3;

/**
 * The denoise a Fix starts on, whatever the family: the bar asks what the painted part becomes, and under the soft brush the
 * Inpaint form's own start (0.75, 0.8) kept what was there. On a pod, SDXL's red umbrella stayed red up to 0.9 and turned at
 * 0.95; Z-Image's black basket stayed at 0.8 on four seeds of four and became the wicker one asked for at 0.9 (card #281).
 */
const FIX_DENOISE = 0.95;

/**
 * Ctrl+Enter runs the bar's job while the bar shows: taken on the capture phase, before the draft's Generate hears it (that
 * one skips a key already taken). Not under a dialog opened over the bar (`root`); the viewer over the screen, a dialog
 * itself, holds the bar and leaves it the key. Nor while ⚙ (a popover), a list or a menu is open: the bar would run on its
 * settings from before the popover's, and the popover's own Enter queues with what it shows.
 */
export function useCtrlEnter(run: () => void, root: RefObject<HTMLElement | null>) {
  const now = useRef(run);
  now.current = run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.defaultPrevented && !dialogOver(root.current) && !document.querySelector(OVER)) {
        e.preventDefault();
        now.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [root]);
}

/**
 * What both of Paint and fix's bars share: the rows set in ⚙, kept for the next run; `go` runs the bar with them (and with
 * rows just changed); Ctrl+Enter runs it while the bar shows (`root` is the bar's element); `tune` opens ⚙ on the job with
 * the rows as last set, its Queue keeping what it changed and running the bar.
 */
export function useTunedBar(run: (tuned: Record<string, unknown>) => void) {
  // ⚙'s rows as last set: the next run is sent with them too
  const [tuned, setTuned] = useState<Record<string, unknown>>({});
  const openTune = useTune((t) => t.open);
  const go = (more: Record<string, unknown> = {}) => run({ ...tuned, ...more });
  const root = useRef<HTMLDivElement>(null);
  useCtrlEnter(go, root);
  const tune = (gear: Element, ask: Omit<TuneAsk, "queue">) =>
    openTune(tuneAt(gear), {
      ...ask,
      job: { ...ask.job, stored: { ...ask.job.stored, ...tuned } },
      queue: (changed) => {
        setTuned((t) => ({ ...t, ...changed }));
        go(changed);
      },
    });
  return { tuned, go, tune, root };
}

/**
 * A bar's text field: it keeps every key typed in it (the layer's P, E, B, V, Del… are not the field's), Enter runs
 * `onEnter` (Ctrl+Enter is the bar's own), Esc gives the focus back to the Stage.
 */
export function BarInput({ onEnter, ref, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "onKeyDown" | "className"> & { onEnter(): void; ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      {...props}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          onEnter();
        }
        if (e.key === "Escape") (e.target as HTMLInputElement).blur();
      }}
      className={cx(fieldClass, "h-9 min-w-60 grow basis-60")}
    />
  );
}

/** Why a bar's last try failed, as useFixJob says it. */
export type BarFailure = { what: string; error: Error };

/** The "?" on both of Paint and fix's bars: what a mask does and what a box does, since both are drawn on the same picture. */
export const MASK_OR_BOX = "Mask: those pixels are inpainted again from a description of what they become (Fix). Box: an edit model follows an instruction there, the rest kept (Edit in box). A mask painted takes the bar; clear it to edit in the boxes";

/** What Fix's bar says of edit boxes drawn while a mask is painted: they are left out of the fix. */
export const boxesIgnored = (n: number) => `Fix uses the mask · ${n === 1 ? "the 1 box is" : `the ${n} boxes are`} ignored`;

/**
 * The bar under the picture in Paint and fix: what the mask is, what the painted part becomes, the denoise, how many
 * versions, ⚙ for the rest (with the full Inpaint form one click away), and Fix. Enter in the prompt and Ctrl+Enter
 * anywhere fix; Ctrl+Enter is the bar's while it shows, not the draft's Generate.
 */
export function FixBar({ verb, tool, job, mask, grow, busy, failure, note, boxes, onFix, onFullForm }: {
  /** A fix of the painted part, an outpaint of the frame dragged out, or an edit of the whole picture: the bar's words, its job the same way. */
  verb: "Fix" | "Outpaint" | "Edit";
  tool: RecipeInfo;
  /** The job as Fix would queue it, for ⚙'s rows to start on. */
  job: QueuedJob;
  /** What the mask holds ("316×278, soft"), or what the frame adds; null: nothing yet. */
  mask: string | null;
  grow: number;
  busy: boolean;
  /** Why the bar's last try failed (not queued, the form not opened): said under it until the next try. */
  failure?: BarFailure | null;
  /** Said under the bar first: why it is not what was asked (Edit with no edit model for this picture). */
  note?: string;
  /**
   * Edit boxes drawn too (card #284): with a mask painted, Fix takes the mask alone, so the bar says the boxes are left out,
   * and Clear mask (one undo step) hands the bar to Edit in box.
   */
  boxes?: { count: number; onClearMask(): void };
  onFix(ask: FixAsk): void;
  onFullForm(ask: Omit<FixAsk, "count">): void;
}) {
  const denoise = tool.inputs.find((i): i is Extract<InputSpec, { type: "number" }> => i.id === "strength" && i.type === "number");
  const [prompt, setPrompt] = useState("");
  const fixing = verb === "Fix";
  // an Edit's img2img keeps its form's start: it redraws the whole picture
  const [strength, setStrength] = useState(fixing ? Math.min(FIX_DENOISE, denoise?.max ?? 1) : typeof denoise?.default === "number" ? denoise.default : 0.75);
  const [count, setCount] = useState(FIX_COUNT);
  const editing = verb === "Edit";
  // an instruction editor has nothing to go on without one; img2img (a denoise) redraws on the picture's own prompt
  const why = editing ? (!prompt.trim() && !denoise ? "Say what to change first" : busy ? "Sending…" : null)
    : !mask ? (fixing ? "Paint the part to redo first" : "Drag the frame's edges out first") : busy ? "Sending…" : null;
  const placeholder = editing ? ((tool.inputs.find((i) => i.id === "prompt") as { placeholder?: string } | undefined)?.placeholder ?? "What to change") : fixing ? "What the painted part becomes" : "What the added parts show";
  const bar = useTunedBar((tuned) => {
    if (!why) onFix({ prompt, strength, grow, tuned, count });
  });
  const fix = () => bar.go();
  const tune = (gear: Element) =>
    bar.tune(gear, {
      action: fixing ? "inpaint" : editing ? "edit" : "outpaint",
      title: fixing ? "Inpaint" : verb,
      sub: plural(count, "version"),
      rows: FIX_ROWS,
      go: `${verb} ×${count}`,
      job,
      more: { label: "Open the full form", run: (changed) => onFullForm({ prompt, strength, grow, tuned: { ...bar.tuned, ...changed } }) },
    });
  return (
    <div ref={bar.root} className="flex w-full max-w-[1040px] shrink-0 flex-col items-center gap-1.5">
      {/* on a narrow stage the prompt keeps a row of its own, the numbers and Fix wrapping under it */}
      <div role="group" aria-label="Fix" className="flex w-full flex-wrap items-center justify-end gap-2">
        {editing ? (
          <Chip tone="accent" tip="An edit works on the whole picture: paint a part (P, B, L, C, D) to fix only that">Whole picture</Chip>
        ) : fixing ? (
          <Chip tone={mask ? "accent" : "neutral"} tip={mask ? "What the fix redoes: the painted part, its soft edge included" : "Paint over the part to redo: P the brush, B a box, L a lasso"}>Mask · {mask ?? "nothing painted"}</Chip>
        ) : (
          <Chip tone={mask ? "accent" : "neutral"} tip="What the outpaint adds round the picture: the frame's edges dragged out (R)">Frame · {mask ?? "the picture's own edges"}</Chip>
        )}
        <BarInput
          aria-label={editing ? "What to change" : fixing ? "What the painted part becomes" : "What the added parts show"}
          value={prompt}
          placeholder={placeholder}
          data-tip={editing && !denoise ? "The instruction: what to change, the rest kept" : "Empty: the picture's own prompt"}
          onChange={(e) => setPrompt(e.target.value)}
          onEnter={fix}
        />
        {denoise && verb !== "Outpaint" && (
          <span className="flex items-center gap-1.5 text-xs text-ink-2">
            Denoise <NumberBox label="Denoise" value={strength} min={denoise.min ?? 0.05} max={denoise.max ?? 1} step={denoise.step ?? 0.05} onCommit={setStrength} />
          </span>
        )}
        <span className="flex items-center gap-1.5 text-xs text-ink-2" data-tip="How many versions one Fix makes, each on a new seed">
          × <NumberBox label="Versions" value={count} min={1} max={MAX_COUNT} onCommit={(n) => setCount(Math.round(n))} />
        </span>
        {/* its own box at the number boxes' height, the bar's gap on each side */}
        <IconButton label="The fix's settings" tip="Steps, sampler… and the full form" tone="outline" size={32} onClick={(e) => tune(e.currentTarget)}>
          <Settings2 size={15} />
        </IconButton>
        <Button tone="primary" disabled={Boolean(why)} data-tip={why ?? `${plural(count, "version")} of the picture, each on a new seed`} onClick={() => fix()} className="h-9 shrink-0">
          <Wand2 size={14} /> {verb} · {plural(count, "version")} <Kbd>Ctrl+Enter</Kbd>
        </Button>
      </div>
      {failure && <Failed inline what={failure.what} error={failure.error} />}
      {note && <span className="text-xs font-semibold text-attention-ink">{note}</span>}
      {fixing && mask && boxes && boxes.count > 0 && (
        <span role="status" className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs font-semibold text-attention-ink">
          {boxesIgnored(boxes.count)}
          <Button size="sm" onClick={boxes.onClearMask} data-tip="Clears the painted mask (Ctrl+Z brings it back): the bar edits in the boxes">
            Clear mask
          </Button>
          <Help title="Mask or box" text={MASK_OR_BOX} />
        </span>
      )}
      <span className="text-xs text-ink-3">{editing && !denoise ? "Paint a part to fix only that" : "Empty prompt: the picture's own"} · <Kbd>Esc</Kbd> leaves {fixing ? "Paint and fix" : verb} · an unkept version expires like any render</span>
    </div>
  );
}
