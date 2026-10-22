import { useQuery } from "@tanstack/react-query";
import { api, type Clip } from "../../api";
import { Chip, cx } from "../../ui";
import { useRecipes } from "../../data";
import { recipeLabel } from "../../format";
import { driftWords } from "../lookDrift";
import { clipFacts } from "./peek";
import { queryKeys } from "../../queryKeys";

/** The tone of a line of the card, by its role: what failed red, what needs a look amber, what happens now the accent. */
const LINE = { warn: "text-warn-ink", attention: "text-attention-ink", dim: "text-ink-2", accent: "text-accent" } as const;

/**
 * The clip's words on the frame card while the pointer is on a clip (see clipFacts), short: its length and how it came
 * to be, its form, its chips (how it joins, which take, how its look slid: the Look card in the Inspector has the
 * figures), what needs a look, and its size on a dim line. Or a few words for a still or a clip with no take.
 */
export function ClipFacts({ clip, index, clips }: { clip: Clip; index: number; clips: Clip[] }) {
  const take = clip.kind === "video" ? clip.take : null;
  // how much the picture jumps where this clip meets the one before: measured once the takes are there
  const joins = useQuery({
    queryKey: queryKeys.joins.around(clip, clips[index - 1], clips[index + 1]),
    queryFn: () => api.joins(clip.id),
    enabled: Boolean(take) && index > 0 && clip.joined === "continue",
    staleTime: 60_000,
  });
  const jump = joins.data?.items.find((j) => j.take === take?.id)?.in ?? null;
  const f = clipFacts(clip, index, clips, jump);
  const form = useFormLine(clip, clips);
  // how its look slid along its run, in words ("darker, softer than clip 1"): a chip that needs a look
  const drift = driftWords(f.drift);
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-body">
      {f.head && (
        <span className="flex flex-wrap items-baseline gap-1.5">
          <b className="font-mono font-semibold text-ink">{f.head.text}</b>
          {f.head.detail && <span className="text-meta text-ink-3">· {f.head.detail}</span>}
        </span>
      )}
      {form && <span className="-mt-1 text-meta text-ink-2">{form}</span>}
      {(f.chips.length > 0 || drift) && (
        <span className="flex flex-wrap gap-1">
          {f.chips.map((c) => <Chip key={c.text} size="xs" tone={c.tone}>{c.text}</Chip>)}
          {drift && <Chip size="xs" tone="attention">{drift}</Chip>}
        </span>
      )}
      {f.lines.map((l) => (
        <span key={l.text} className={l.tone ? LINE[l.tone] : "font-semibold text-ink"}>{l.text}</span>
      ))}
      {f.foot.length > 0 && (
        <span className="text-micro text-ink-3">
          {f.foot.map((l, i) => (
            <span key={l.text}>{i > 0 && " · "}<span className={cx(l.tone === "accent" && "text-accent")}>{l.text}</span></span>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * The clip's form, as the card says it (the rethink: the track names no model, the card does): "MiniMax H3 · Motion transfer",
 * and for a window of the source which one it is ("window 2 of the source"). Null for a still or a clip with no model.
 */
function useFormLine(clip: Clip, clips: Clip[]): string | null {
  const data = useRecipes().data;
  const recipe = data?.recipes.find((r) => r.id === clip.recipe);
  if (clip.kind !== "video" || !recipe) return null;
  const name = recipeLabel(data?.families.find((f) => f.id === recipe.family)?.name, recipe.title);
  const driving = recipe.traits?.windows ? recipe.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window) : undefined;
  const asset = driving ? (clip.inputs[driving.id] as { asset?: string } | undefined)?.asset : undefined;
  if (!driving || !asset) return name;
  // its place among the clips made from the same video: the windows of one source, in order
  const of = (c: Clip) => c.kind === "video" && (c.inputs[driving.id] as { asset?: string } | undefined)?.asset === asset;
  const k = clips.filter(of).indexOf(clip) + 1;
  return k > 0 ? `${name} · window ${k} of the source` : name;
}
