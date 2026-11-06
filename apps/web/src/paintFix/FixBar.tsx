import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type Ref, type RefObject } from "react";
import { Settings2, Wand2 } from "lucide-react";
import type { InputSpec } from "@afflatus/core";
import type { RecipeInfo } from "../api";
import { plural } from "../format";
import { dialogOver, OVER } from "../Dialog";
import { Kbd } from "../Keys";
import { BOX_TONE } from "../stageLayer/LayerStrip";
import { MAX_COUNT, tuneAt, useTune, type TuneAsk } from "../passTune";
import type { QueuedJob } from "../queueVariation";
import { Button, cx, Failed, Help, IconButton, NumberBox } from "../ui";
import type { FixAsk } from "../passes";

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
 * settings from before the popover's, and the popover's own Enter queues with what it shows. A number box being typed in
 * commits on blur: it is left first, and the bar runs once its value is in (it ran on the number before, card #324).
 */
function useCtrlEnter(run: () => void, root: RefObject<HTMLElement | null>) {
  const now = useRef(run);
  now.current = run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.defaultPrevented && !dialogOver(root.current) && !document.querySelector(OVER)) {
        e.preventDefault();
        const box = document.activeElement;
        if (box instanceof HTMLElement && box.matches("[data-commits-on-blur]")) {
          box.blur();
          setTimeout(() => now.current());
        } else now.current();
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
      className="h-8 min-w-32 grow basis-32 rounded-control border border-transparent bg-shade/25 px-3 text-body text-ink outline-none transition-colors placeholder:text-ink-3 hover:border-line-strong focus:border-line-strong"
    />
  );
}

/**
 * Both bars' capsule (owner's pick on mock-0.10-paint-look): one floating row under the picture, translucent over the Stage.
 * On a narrow Stage it wraps, the field keeping a row of its own.
 */
export const BAR_CAPSULE = "@container flex w-full flex-wrap items-center justify-end gap-1.5 rounded-card border border-line bg-panel/85 p-1.5 shadow-pop backdrop-blur-xl";

/** What a bar works on, first in its capsule: the mask (accent, a soft swatch) or an edit box (the box's blue, ✦). */
export function BarWhat({ tone, tip, children }: { tone: "mask" | "box" | "none"; tip: string; children: ReactNode }) {
  return (
    <span
      data-tip={tip}
      className={cx(
        "inline-flex h-8 shrink-0 items-center gap-2 rounded-control px-2.5 text-xs font-bold whitespace-nowrap",
        tone === "mask" ? "bg-accent-wash text-accent" : tone === "box" ? BOX_TONE : "bg-hover text-ink-2",
      )}
    >
      {tone === "mask" && <span aria-hidden className="size-3.5 shrink-0 rounded-key bg-[radial-gradient(circle,var(--color-accent)_35%,transparent_72%)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]" />}
      {children}
    </span>
  );
}

/**
 * The button's Ctrl+Enter keycaps, shown while the capsule has the room (from 864 px): at 1280 wide with the side panel open
 * they would take the field's room and cut its placeholder. The key is still in the button's tip and on the keys sheet.
 */
export function GoKeys() {
  return (
    <span className="hidden @[54rem]:contents">
      <Kbd>Ctrl+Enter</Kbd>
    </span>
  );
}

/** A number of the bar (denoise, how many), its name before it, quiet. */
const BAR_FIELD = "flex h-8 shrink-0 items-center gap-1.5 px-1 text-xs text-ink-3";

/** Why a bar's last try failed, as useFixJob says it. */
export type BarFailure = { what: string; error: Error };

/** The "?" on both of Paint and fix's bars: what a mask does and what a box does, since both are drawn on the same picture. */
export const MASK_OR_BOX = "Mask: inpainted from the prompt (Fix). Box: an edit model follows the box's instruction (Edit in box). A painted mask takes the bar";

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
    <div ref={bar.root} className="flex w-full max-w-[940px] shrink-0 flex-col items-center gap-1.5">
      {/* on a narrow stage the prompt keeps a row of its own, the numbers and Fix wrapping under it */}
      <div role="group" aria-label="Fix" className={BAR_CAPSULE}>
        {editing ? (
          <BarWhat tone="mask" tip="An edit works on the whole picture: paint a part (P, B, L, C, D) to fix only that"><span>Whole picture</span></BarWhat>
        ) : fixing ? (
          <BarWhat tone={mask ? "mask" : "none"} tip={mask ? "What the fix redoes: the painted part, its soft edge included" : "Paint over the part to redo: P the brush, B a box, L a lasso"}><span>Mask · {mask ?? "nothing painted"}</span></BarWhat>
        ) : (
          <BarWhat tone={mask ? "mask" : "none"} tip="What the outpaint adds round the picture: the frame's edges dragged out (R)"><span>Frame · {mask ?? "the picture's own edges"}</span></BarWhat>
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
          <span className={BAR_FIELD}>
            Denoise <NumberBox narrow label="Denoise" value={strength} min={denoise.min ?? 0.05} max={denoise.max ?? 1} step={denoise.step ?? 0.05} onCommit={setStrength} />
          </span>
        )}
        <span className={BAR_FIELD} data-tip="How many versions one Fix makes, each on a new seed">
          × <NumberBox narrow label="Versions" value={count} min={1} max={MAX_COUNT} onCommit={(n) => setCount(Math.round(n))} />
        </span>
        {/* its own box at the number boxes' height, the bar's gap on each side */}
        <IconButton label="The fix's settings" tip="Steps, sampler… and the full form" size={32} data-soft-focus onClick={(e) => tune(e.currentTarget)}>
          <Settings2 size={15} />
        </IconButton>
        <Button tone="primary" disabled={Boolean(why)} data-tip={why ?? `${plural(count, "version")} of the picture, each on a new seed`} data-tip-keys="Ctrl+Enter" onClick={() => fix()} className="h-8 shrink-0" data-soft-focus>
          <Wand2 size={14} /> {verb} · {plural(count, "version")} <GoKeys />
        </Button>
      </div>
      {failure && <Failed inline what={failure.what} error={failure.error} />}
      {note && <span className="text-xs font-semibold text-attention-ink">{note}</span>}
      {fixing && mask && boxes && boxes.count > 0 && (
        <span role="status" className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-xs text-ink-2">
          {/* the boxes' own look while ignored: grey, dashed, still (useRegionTool's "ignored") */}
          <span aria-hidden className="h-[13px] w-[18px] shrink-0 rounded-xs border-[1.5px] border-dashed border-ink-3" />
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
