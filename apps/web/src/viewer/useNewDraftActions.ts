import { useMutation } from "@tanstack/react-query";
import { secondsInput } from "@afflatus/core";
import type { Range } from "../Trim";
import { api, type Asset, type AssetDetail, type Look, type RecipeInfo } from "../api";
import { useDrafts, useFamilies, useRecipes, useSetup, type useAsset } from "../data";
import { useOpenNewDraft } from "../draft";
import { handMask } from "../handoff";
import { useReuse } from "../reuse";
import { carryOver, followOn, modelGroups, usedLast } from "../picker";
import { OPS, ownInputs } from "./shared";

/** What a tool is handed along with a picture: what the picture was made with (its prompt, model, LoRAs…), where the tool has a place for it. `withLook`: its cast goes along. */
function carried(g: AssetDetail["generation"] | null | undefined, from: RecipeInfo | undefined, to: RecipeInfo, withLook: boolean): Record<string, unknown> {
  if (!g || !from) return {};
  // the picture is the new source; its own source, mask and seed stay behind
  const taken = carryOver(from, to, ownInputs(g, withLook), undefined);
  for (const i of to.inputs) if (i.type === "image" || i.type === "seed") delete taken[i.id];
  return taken;
}

/**
 * Who a new draft made from this starts with: the people, the places and the style it was made with.
 * (Not its ticked snippets: those were bits of text for the model it was made with.) The prompt it carries
 * is the one written before the server worked their words in (`asked`, see ownInputs).
 */
const castOf = (d: AssetDetail | undefined): Look | null => (d?.id && d.look && (d.look.cast.length || d.look.style) ? { cast: d.look.cast, style: d.look.style ?? null, snippets: [] } : null);

/**
 * What the viewer opens a new draft with, on the item shown: the same settings again (the seed kept or not), a clip that carries
 * on from it or starts at one of its moments, a video of a picture, a tool's form with the picture in place,
 * a model that follows a person or a voice. `leave` is called before the form opens.
 */
export function useNewDraftActions({ asset, detail, leave }: { asset: Asset; detail: ReturnType<typeof useAsset>; leave(): void }) {
  const recipes = useRecipes();
  const setup = useSetup();
  const openNew = useOpenNewDraft();
  const toForm = (d: Awaited<ReturnType<typeof api.createDraft>>) => {
    leave();
    openNew(d);
  };
  const g = detail.data?.id === asset.id ? detail.data.generation : null;
  const a: Asset = detail.data?.id === asset.id ? detail.data : asset;
  const recipe = recipes.data?.recipes.find((r) => r.id === g?.recipe);
  /** The same settings as a new draft, its seed kept (L) or a new one (Shift+L). */
  const reuse = useReuse({ leave });

  // a new clip that carries on from this video, on the model the video was made with and with its settings: with
  // the video in its "carries on from" slot when that model can join a clip, else opening on the video's last
  // frame. A video made with nothing that can do either carries on on a model that joins clips
  const on = useFamilies().isOn;
  const joins = (r: RecipeInfo) => r.inputs.find((i) => i.type === "clip" && i.role === "previous");
  const opensOn = (r: RecipeInfo) => (r.output === "video" ? r.inputs.find((i) => i.type === "image" && i.role === "start") : undefined);
  const own = recipe && on(recipe.family) && (joins(recipe) || opensOn(recipe)) ? recipe : undefined;
  const carrier = own ?? recipes.data?.recipes.find((r) => on(r.family) && joins(r));
  const fromLastFrame = Boolean(carrier && !joins(carrier));
  const carryOn = useMutation({
    mutationFn: async () => {
      const to = carrier!;
      const settings = followOn(recipe, to, g ? ownInputs(g, Boolean(castOf(detail.data))) : undefined);
      const slot = joins(to);
      if (slot) return api.createDraft({ recipe: to.id, forms: { [to.id]: { ...settings, [slot.id]: { asset: asset.id } } }, look: castOf(detail.data) });
      // past its end, the last frame that can be read is the one taken
      const last = await api.frame(asset.id, a.durationMs ?? 0);
      return api.createDraft({ recipe: to.id, forms: { [to.id]: { ...settings, [opensOn(to)!.id]: last.id } }, look: castOf(detail.data) });
    },
    onSuccess: toForm,
  });

  // a picture as the first frame of a new video: a draft on the video model used last among those that can
  // open on a picture (the form can still be put on another one: the picture goes along)
  const drafts = useDrafts();
  const opener = usedLast(
    (recipes.data?.recipes ?? []).filter((r) => on(r.family) && r.output === "video" && r.inputs.some((i) => i.type === "image" && i.role === "start")),
    drafts.data?.items,
    (r) => Boolean(setup.data?.recipes.find((x) => x.id === r.id)?.ready),
  );
  const openerName = opener ? (recipes.data?.families.find((f) => f.id === opener.family)?.name ?? opener.title) : "";

  /** A new clip from the frame at in to the frame at out, on the video model used last: first frame, last frame, duration = the range. */
  const between = useMutation({
    mutationFn: async (range: Range) => {
      const to = opener!;
      const first = await api.frame(asset.id, Math.round(range.startMs));
      const last = await api.frame(asset.id, Math.round(range.endMs));
      const start = to.inputs.find((i) => i.type === "image" && i.role === "start")!;
      const end = to.inputs.find((i) => i.type === "image" && i.role === "end");
      const seconds = secondsInput(to.inputs);
      const length = (range.endMs - range.startMs) / 1000;
      const snapped = seconds ? Math.max(seconds.min, Math.min(seconds.max, Math.round(length / seconds.step) * seconds.step)) : undefined;
      return api.createDraft({ recipe: to.id, forms: { [to.id]: { [start.id]: first.id, ...(end ? { [end.id]: last.id } : {}), ...(seconds && snapped !== undefined ? { [seconds.id]: Number(snapped.toFixed(3)) } : {}) } }, look: castOf(detail.data) });
    },
    onSuccess: toForm,
  });
  /** A new clip that starts at a moment of this one: H3 carries the motion on from there (the clip input's moment), the others open on that frame. */
  const extendHere = useMutation({
    mutationFn: async (atMs: number) => {
      const to = carrier ?? opener!;
      const settings = carrier ? followOn(recipe, to, g ? ownInputs(g, Boolean(castOf(detail.data))) : undefined) : {};
      const slot = carrier ? joins(to) : null;
      if (slot) return api.createDraft({ recipe: to.id, forms: { [to.id]: { ...settings, [slot.id]: { asset: asset.id, at: Math.round(atMs) } } }, look: castOf(detail.data) });
      const frame = await api.frame(asset.id, Math.round(atMs));
      const start = to.inputs.find((i) => i.type === "image" && i.role === "start")!;
      return api.createDraft({ recipe: to.id, forms: { [to.id]: { ...settings, [start.id]: frame.id } }, look: castOf(detail.data) });
    },
    onSuccess: toForm,
  });
  const animate = useMutation({
    mutationFn: () => {
      const slot = opener!.inputs.find((i) => i.type === "image" && i.role === "start")!;
      return api.createDraft({ recipe: opener!.id, forms: { [opener!.id]: { [slot.id]: asset.id } }, look: castOf(detail.data) });
    },
    onSuccess: toForm,
  });
  // a picture of someone, or a voice, straight into a new draft of a model that follows them
  const follower = recipes.data?.recipes.find((r) => on(r.family) && r.inputs.some((i) => (asset.kind === "audio" ? i.type === "audio" && i.role === "voice" : i.type === "references")));
  const follow = useMutation({
    mutationFn: () => {
      const slot = follower!.inputs.find((i) => (asset.kind === "audio" ? i.type === "audio" : i.type === "references"))!;
      return api.createDraft({ recipe: follower!.id, forms: { [follower!.id]: { [slot.id]: asset.kind === "audio" ? asset.id : [{ asset: asset.id, role: "person" }] } } });
    },
    onSuccess: toForm,
  });

  const all = (recipes.data?.recipes ?? []).filter((r) => on(r.family));
  /** The recipe for an operation: the one of the model the picture was made with when it has it, else one that is ready, else any. */
  const toolFor = (key: string): RecipeInfo | undefined => {
    const ends = OPS[key]?.ends ?? [];
    const fits = (r: RecipeInfo) => r.output === "image" && ends.some((e) => r.id.endsWith(e));
    const mine = modelGroups(all.filter((r) => r.output === "image"), recipes.data?.families ?? []).find((group) => group.recipes.some((r) => r.id === recipe?.id));
    const ready = (r: RecipeInfo) => setup.data?.recipes.find((x) => x.id === r.id)?.ready;
    return mine?.recipes.find(fits) ?? all.find((r) => fits(r) && ready(r)) ?? all.find(fits);
  };
  /** What a tool is handed with the picture in its source slot; `withLook`: its cast goes along too. */
  const toolInput = (tool: RecipeInfo, withLook = false) => {
    const slot = tool.inputs.find((i) => i.type === "image" && i.role === "source")!;
    return { ...carried(g, recipe, tool, withLook), [slot.id]: asset.id };
  };
  /** A tool's form, with the picture in place and what it was made with. */
  const openTool = useMutation({
    mutationFn: (id: string) => {
      const tool = all.find((r) => r.id === id)!;
      const look = castOf(detail.data);
      return api.createDraft({ recipe: tool.id, forms: { [tool.id]: toolInput(tool, Boolean(look)) }, look });
    },
    onSuccess: (d, id) => {
      // a tool that redoes a painted part (Inpaint) opens on its painter: painting the mask is the next step anyway
      if (all.find((r) => r.id === id)?.inputs.some((i) => i.type === "image" && i.role === "mask")) handMask(asset.id);
      toForm(d);
    },
  });

  return { a, g, recipe, recipes, reuse, carrier, fromLastFrame, carryOn, between, extendHere, opener, openerName, animate, follower, follow, toolFor, toolInput, openTool };
}
