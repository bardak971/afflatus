import { LIMITS } from "@afflatus/core";
import type { Look } from "../api/types/designer";

/**
 * Where the bar's `@name` puts a person: the clip selected in the open timeline editor when its model takes a person,
 * else the open draft. Worked out apart from the bar.
 */

/** What the bar reads of a form's input. */
type FormInput = { type: string; media?: string; role?: string; roles?: readonly string[] };

/** What the bar needs of the selected clip (bridge.ts's SelectedClip). */
export interface ClipCast {
  timelineName: string;
  number: number;
  kind: "video" | "still";
  /** Its model's form: null for an imported video or a clip with no model yet. */
  recipe: { title: string; inputs: readonly FormInput[] } | null;
  /** Who is in it: its own cast, else the timeline's. */
  look: Look | null;
}

/** Why a model takes no person (null: it does). A person goes in as reference pictures, a voice, or words of the prompt. */
function noPersonIn(inputs: readonly FormInput[]): string | null {
  const takes = inputs.some((i) =>
    (i.type === "references" && !i.media && (!i.roles || i.roles.includes("person")))
    || (i.type === "audio" && i.role === "voice")
    || i.type === "prompt");
  return takes ? null : "takes no person (no references, voice or prompt)";
}

/** Why the selected clip cannot take a person now, or null. */
export function clipRefuses(clip: ClipCast): string | null {
  if (clip.kind === "still") return `clip ${clip.number} is a still picture`;
  if (!clip.recipe) return `clip ${clip.number} has no model to render it with`;
  const why = noPersonIn(clip.recipe.inputs);
  if (why) return `clip ${clip.number}'s model, ${clip.recipe.title}, ${why}`;
  if ((clip.look?.cast.length ?? 0) >= LIMITS.cast) return `clip ${clip.number} has ${LIMITS.cast} people and places, the most`;
  return null;
}

/** Where a person goes, and the row's line that says it. */
export function castPlace(clip: ClipCast | null): { to: "clip" | "draft"; why: string | null; detail: string } {
  const why = clip ? clipRefuses(clip) : null;
  if (clip && !why) return { to: "clip", why: null, detail: `→ clip ${clip.number} of ${clip.timelineName}` };
  return { to: "draft", why, detail: why ? `→ the open draft · ${why}` : "→ the open draft" };
}

/** A look with this person added at the end; null when they are in it already. */
export function withPerson(look: Look | null, id: string): Look | null {
  const now: Look = look ?? { cast: [], style: null, snippets: [] };
  if (now.cast.some((c) => c.id === id)) return null;
  return { ...now, cast: [...now.cast, { id }] };
}
