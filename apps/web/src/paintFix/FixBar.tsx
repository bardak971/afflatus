import { useEffect, useRef, useState } from "react";
import { Settings2, Wand2 } from "lucide-react";
import type { InputSpec } from "@afflatus/core";
import type { RecipeInfo } from "../api";
import { plural } from "../format";
import { Kbd } from "../Keys";
import { MAX_COUNT, tuneAt, useTune } from "../passTune";
import type { QueuedJob } from "../queueVariation";
import { Button, Chip, cx, fieldClass, IconButton, NumberBox } from "../ui";
import type { FixAsk } from "./useFixJob";

/**
 * The fix's settings in ⚙: the sampling, and an outpaint's feathering. Short, so the popover leaves the picture in sight.
 * The prompt, denoise and grow are on the bar and the strip; the mask's soft edge is the layer's Feather, so the recipe's
 * Mask blur is not offered twice; it and the negative prompt stay in the full form.
 */
export const FIX_ROWS = ["feathering", "steps", "cfg", "sampler", "scheduler"] as const;

/** How many versions a Fix makes when nothing else was asked (the mock's ×3). */
export const FIX_COUNT = 3;

/**
 * The bar under the picture in Paint and fix: what the mask is, what the painted part becomes, the denoise, how many
 * versions, ⚙ for the rest (with the full Inpaint form one click away), and Fix. Enter in the prompt and Ctrl+Enter
 * anywhere fix; Ctrl+Enter is the bar's while it shows, not the draft's Generate.
 */
export function FixBar({ verb, tool, job, mask, grow, busy, note, onFix, onFullForm }: {
  /** A fix of the painted part, an outpaint of the frame dragged out, or an edit of the whole picture: the bar's words, its job the same way. */
  verb: "Fix" | "Outpaint" | "Edit";
  tool: RecipeInfo;
  /** The job as Fix would queue it, for ⚙'s rows to start on. */
  job: QueuedJob;
  /** What the mask holds ("316×278, soft"), or what the frame adds; null: nothing yet. */
  mask: string | null;
  grow: number;
  busy: boolean;
  /** Said under the bar first: why it is not what was asked (Edit with no edit model for this picture). */
  note?: string;
  onFix(ask: FixAsk): void;
  onFullForm(ask: Omit<FixAsk, "count">): void;
}) {
  const denoise = tool.inputs.find((i): i is Extract<InputSpec, { type: "number" }> => i.id === "strength" && i.type === "number");
  const [prompt, setPrompt] = useState("");
  const [strength, setStrength] = useState(typeof denoise?.default === "number" ? denoise.default : 0.75);
  const [count, setCount] = useState(FIX_COUNT);
  // ⚙'s rows as last set: the next Fix is sent with them too
  const [tuned, setTuned] = useState<Record<string, unknown>>({});
  const openTune = useTune((t) => t.open);
  const ask = { prompt, strength, grow, tuned };
  const fixing = verb === "Fix";
  const editing = verb === "Edit";
  // an instruction editor has nothing to go on without one; img2img (a denoise) redraws on the picture's own prompt
  const why = editing ? (!prompt.trim() && !denoise ? "Say what to change first" : busy ? "Sending…" : null)
    : !mask ? (fixing ? "Paint the part to redo first" : "Drag the frame's edges out first") : busy ? "Sending…" : null;
  const placeholder = editing ? ((tool.inputs.find((i) => i.id === "prompt") as { placeholder?: string } | undefined)?.placeholder ?? "What to change") : fixing ? "What the painted part becomes" : "What the added parts show";
  const fix = (more: Record<string, unknown> = {}) => {
    if (!why) onFix({ ...ask, tuned: { ...tuned, ...more }, count });
  };
  const tune = (gear: Element) =>
    openTune(tuneAt(gear), {
      action: fixing ? "inpaint" : editing ? "edit" : "outpaint",
      title: fixing ? "Inpaint" : verb,
      sub: plural(count, "version"),
      rows: FIX_ROWS,
      go: `${verb} ×${count}`,
      job: { ...job, stored: { ...job.stored, ...tuned } },
      queue: (changed) => {
        setTuned((t) => ({ ...t, ...changed }));
        fix(changed);
      },
      more: { label: "Open the full form", run: (changed) => onFullForm({ ...ask, tuned: { ...tuned, ...changed } }) },
    });
  // Ctrl+Enter fixes while the bar shows: taken before the draft's Generate hears it (that one skips a key already taken)
  const fixNow = useRef(fix);
  fixNow.current = fix;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.defaultPrevented && !document.querySelector("[role=dialog][aria-modal=true]")) {
        e.preventDefault();
        fixNow.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className="flex w-full max-w-[1040px] shrink-0 flex-col items-center gap-1.5">
      {/* on a narrow stage the prompt keeps a row of its own, the numbers and Fix wrapping under it */}
      <div role="group" aria-label="Fix" className="flex w-full flex-wrap items-center justify-end gap-2">
        {editing ? (
          <Chip tone="accent" tip="An edit works on the whole picture: paint a part (P, B, L, C, D) to fix only that">Whole picture</Chip>
        ) : fixing ? (
          <Chip tone={mask ? "accent" : "neutral"} tip={mask ? "What the fix redoes: the painted part, its soft edge included" : "Paint over the part to redo: P the brush, B a box, L a lasso"}>Mask · {mask ?? "nothing painted"}</Chip>
        ) : (
          <Chip tone={mask ? "accent" : "neutral"} tip="What the outpaint adds round the picture: the frame's edges dragged out (R)">Frame · {mask ?? "the picture's own edges"}</Chip>
        )}
        <input
          aria-label={editing ? "What to change" : fixing ? "What the painted part becomes" : "What the added parts show"}
          value={prompt}
          placeholder={placeholder}
          data-tip={editing && !denoise ? "The instruction: what to change, the rest kept" : "Empty: the picture's own prompt"}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // the layer's keys (P, E, [ ]…) are not the prompt's: it keeps every key typed in it
            e.stopPropagation();
            if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              fix();
            }
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          className={cx(fieldClass, "h-9 min-w-60 grow basis-60")}
        />
        {denoise && verb !== "Outpaint" && (
          <span className="flex items-center gap-1.5 text-xs text-ink-2">
            Denoise <NumberBox label="Denoise" value={strength} min={denoise.min ?? 0.05} max={denoise.max ?? 1} step={denoise.step ?? 0.05} onCommit={setStrength} className="w-16" />
          </span>
        )}
        <span className="flex items-center gap-1.5 text-xs text-ink-2" data-tip="How many versions one Fix makes, each on a new seed">
          × <NumberBox label="Versions" value={count} min={1} max={MAX_COUNT} onCommit={(n) => setCount(Math.round(n))} className="w-12" />
        </span>
        <IconButton label="The fix's settings" tip="The fix's settings: mask blur, steps, sampler… and the full Inpaint form" tone="outline" size={36} onClick={(e) => tune(e.currentTarget)}>
          <Settings2 size={15} />
        </IconButton>
        <Button tone="primary" disabled={Boolean(why)} data-tip={why ?? `${plural(count, "version")} of the picture, each on a new seed`} onClick={() => fix()} className="h-9 shrink-0">
          <Wand2 size={14} /> {verb} · {plural(count, "version")} <Kbd>Ctrl+Enter</Kbd>
        </Button>
      </div>
      {note && <span className="text-xs font-semibold text-attention-ink">{note}</span>}
      <span className="text-xs text-ink-3">{editing && !denoise ? "Paint a part to fix only that" : "Empty prompt: the picture's own"} · <Kbd>Esc</Kbd> leaves {fixing ? "Paint and fix" : verb} · an unkept version expires like any render</span>
    </div>
  );
}
