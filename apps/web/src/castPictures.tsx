import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ReferenceRole, ReferenceValue } from "@afflatus/core";
import { api } from "./api";
import { lookAdds, type Look } from "./api/types/designer";
import type { RecipeInfo } from "./api/types/models";
import { queryKeys } from "./queryKeys";

/** A reference picture the cast adds when the form is sent: whose it is. */
/** A picture the cast adds; `cutout`: a person's own, without its background (the server's kitCutouts.ts). */
export interface CastPicture { asset: string; role: ReferenceRole; from: string; cutout?: boolean }
/** The voice sample the cast adds when the form is sent (a person's own), whose it is, and the part of it set on them. */
export interface CastVoice { asset: string; from: string; part?: { start: number; seconds: number } }

const Ctx = createContext<{ pictures: Record<string, CastPicture[]>; voices: Record<string, CastVoice> }>({ pictures: {}, voices: {} });

/** The cast's pictures for a reference input of the form around it (none outside a form with a cast). */
export const useCastPictures = (input: string): CastPicture[] => useContext(Ctx).pictures[input] ?? [];
/** The cast's voice sample for the form's voice input, used when the form has none of its own. */
export const useCastVoice = (input: string): CastVoice | undefined => useContext(Ctx).voices[input];

/**
 * The reference pictures and the voice sample the form's cast adds when it is sent (the server's compose, which does the same
 * at send time), for the reference and voice fields to show beside the user's own. Asked with the references only, so that
 * typing in the prompt asks nothing.
 */
export function CastPictures({ recipe, input, look, children }: { recipe: RecipeInfo; input: Record<string, unknown>; look: Look | null | undefined; children: ReactNode }) {
  const spec = recipe.inputs.find((i) => i.type === "references" && !("media" in i && i.media));
  const voiceSpec = recipe.inputs.find((i) => i.type === "audio" && i.role === "voice");
  const own = (spec ? (input[spec.id] as ReferenceValue[] | undefined) : undefined) ?? [];
  const asked = Boolean((spec || voiceSpec) && look?.cast.length && lookAdds(look));
  const composed = useQuery({
    queryKey: queryKeys.compose.pictures(recipe.id, look?.cast, own),
    queryFn: () => api.compose(recipe.id, spec ? { [spec.id]: own } : {}, { cast: look!.cast }),
    enabled: asked,
  });
  const added = asked ? composed.data?.added : undefined;
  const value = useMemo(() => ({
    pictures: spec && added?.refs ? { [spec.id]: added.refs } : {},
    // asked without the form's own sample: the field shows it only while the form has none, as the send then uses it
    voices: voiceSpec && added?.voiceAsset && added.voice ? { [voiceSpec.id]: { asset: added.voiceAsset, from: added.voice, part: added.voicePart ?? undefined } } : {},
  }), [spec, voiceSpec, added]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
