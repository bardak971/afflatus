import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ReferenceRole, ReferenceValue } from "@afflatus/core";
import { api } from "./api";
import { lookAdds, type Look } from "./api/types/designer";
import type { RecipeInfo } from "./api/types/models";
import { queryKeys } from "./queryKeys";

/** A reference picture the cast adds when the form is sent: whose it is. */
export interface CastPicture { asset: string; role: ReferenceRole; from: string }

const Ctx = createContext<Record<string, CastPicture[]>>({});

/** The cast's pictures for a reference input of the form around it (none outside a form with a cast). */
export const useCastPictures = (input: string): CastPicture[] => useContext(Ctx)[input] ?? [];

/**
 * The reference pictures the form's cast adds when it is sent (the server's compose, which does the same at send time), for the
 * reference field to show beside the user's own. Asked with that input only, so that typing in the prompt asks nothing.
 */
export function CastPictures({ recipe, input, look, children }: { recipe: RecipeInfo; input: Record<string, unknown>; look: Look | null | undefined; children: ReactNode }) {
  const spec = recipe.inputs.find((i) => i.type === "references" && !("media" in i && i.media));
  const own = (spec ? (input[spec.id] as ReferenceValue[] | undefined) : undefined) ?? [];
  const asked = Boolean(spec && look?.cast.length && lookAdds(look));
  const composed = useQuery({
    queryKey: queryKeys.compose.pictures(recipe.id, look?.cast, own),
    queryFn: () => api.compose(recipe.id, { [spec!.id]: own }, { cast: look!.cast }),
    enabled: asked,
  });
  const value = asked && spec && composed.data?.added.refs ? { [spec.id]: composed.data.added.refs } : {};
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
