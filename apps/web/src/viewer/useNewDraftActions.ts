import { useMutation } from "@tanstack/react-query";
import { secondsInput } from "@afflatus/core";
import type { Range } from "../Trim";
import { api, type Asset, type AssetDetail, type Look, type RecipeInfo } from "../api";
import { useDrafts, useFamilies, useRecipes, useSetup, type useAsset } from "../data";
import { useOpenNewDraft } from "../draft";
import { handMask } from "../handoff";
import { useReuse } from "../reuse";
import { followOn, usedLast } from "../picker";
import { carried, ownInputs, renderOf, toolOf } from "./shared";
import { useFormAim } from "../recipeForm/formAim";

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
export function useNewDraftActions({ asset, detail, leave, enabled = true }: { asset: Asset; detail: ReturnType<typeof useAsset>; leave(): void; /** Off while a menu that uses it is closed: the drafts are not read for nothing. */ enabled?: boolean }) {
  const recipes = useRecipes();
  const setup = useSetup();
  const openNew = useOpenNewDraft();
  const toForm = (d: Awaited<ReturnType<typeof api.createDraft>>) => {
    leave();
    openNew(d);
  };
  /** The form of `recipe` opens on `input`, the slot this action fills (recipeForm/formAim.ts). */
  const aim = (recipe: RecipeInfo, input: string | undefined) => {
    if (input) useFormAim.getState().set(recipe.id, input);
  };
  const g = detail.data?.id === asset.id ? detail.data.generation : null;
  const a: Asset = detail.data?.id === asset.id ? detail.data : asset;
  const recipe = recipes.data?.recipes.find((r) => r.id === g?.recipe);
  // what a tool carries: the item's own render, else that of the item it was taken from (a mirrored copy has none of its
  // own, and its face detailer went out on the server's fallback checkpoint instead of the picture's)
  const made = detail.data?.id === asset.id ? renderOf(detail.data) : null;
  const madeWith = recipes.data?.recipes.find((r) => r.id === made?.recipe);
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
      aim(to, slot?.id ?? opensOn(to)?.id);
      if (slot) return api.createDraft({ recipe: to.id, forms: { [to.id]: { ...settings, [slot.id]: { asset: asset.id } } }, look: castOf(detail.data) });
      // past its end, the last frame that can be read is the one taken
      const last = await api.frame(asset.id, a.durationMs ?? 0);
      return api.createDraft({ recipe: to.id, forms: { [to.id]: { ...settings, [opensOn(to)!.id]: last.id } }, look: castOf(detail.data) });
    },
    onSuccess: toForm,
  });

  // a picture as the first frame of a new video: a draft on the video model used last among those that can
  // open on a picture (the form can still be put on another one: the picture goes along)
  const drafts = useDrafts(enabled);
  const ready = (r: RecipeInfo) => Boolean(setup.data?.recipes.find((x) => x.id === r.id)?.ready);
  const nameOf = (r: RecipeInfo) => recipes.data?.families.find((f) => f.id === r.family)?.name ?? r.title;
  const openers = (recipes.data?.recipes ?? []).filter((r) => on(r.family) && r.output === "video" && r.inputs.some((i) => i.type === "image" && i.role === "start"));
  const opener = usedLast(openers, drafts.data?.items, ready);
  const openerName = opener ? nameOf(opener) : "";

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
      aim(to, start.id);
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
      aim(to, slot?.id ?? to.inputs.find((i) => i.type === "image" && i.role === "start")?.id);
      if (slot) return api.createDraft({ recipe: to.id, forms: { [to.id]: { ...settings, [slot.id]: { asset: asset.id, at: Math.round(atMs) } } }, look: castOf(detail.data) });
      const frame = await api.frame(asset.id, Math.round(atMs));
      const start = to.inputs.find((i) => i.type === "image" && i.role === "start")!;
      return api.createDraft({ recipe: to.id, forms: { [to.id]: { ...settings, [start.id]: frame.id } }, look: castOf(detail.data) });
    },
    onSuccess: toForm,
  });
  /** A new video with the picture as its first frame: on the model asked for (the submenu), else the one used last. */
  const animate = useMutation({
    mutationFn: (id?: string) => {
      const to = openers.find((r) => r.id === id) ?? opener!;
      const slot = to.inputs.find((i) => i.type === "image" && i.role === "start")!;
      aim(to, slot.id);
      return api.createDraft({ recipe: to.id, forms: { [to.id]: { [slot.id]: asset.id } }, look: castOf(detail.data) });
    },
    onSuccess: toForm,
  });
  // a picture of someone, or a voice (a sound, or a video's sound), straight into a new draft of a model that follows them
  const voiced = asset.kind !== "image";
  const follower = recipes.data?.recipes.find((r) => on(r.family) && r.inputs.some((i) => (voiced ? i.type === "audio" && i.role === "voice" : i.type === "references")));
  const follow = useMutation({
    mutationFn: () => {
      const slot = follower!.inputs.find((i) => (voiced ? i.type === "audio" && i.role === "voice" : i.type === "references"))!;
      aim(follower!, slot.id);
      return api.createDraft({ recipe: follower!.id, forms: { [follower!.id]: { [slot.id]: voiced ? asset.id : [{ asset: asset.id, role: "person" }] } } });
    },
    onSuccess: toForm,
  });

  // Motion transfer: a picture as what moves, a video as how it moves, on the model used last among those that do it
  const pictureSlot = (r: RecipeInfo) => r.inputs.find((i) => i.type === "image" && i.role === "source");
  const drivingSlot = (r: RecipeInfo) => r.inputs.find((i) => i.type === "clip" && i.role === "source");
  const movers = (recipes.data?.recipes ?? []).filter((r) => on(r.family) && r.output === "video" && pictureSlot(r) && drivingSlot(r));
  const mover = usedLast(movers, drafts.data?.items, ready);
  const moverName = mover ? nameOf(mover) : "";
  /** A Motion transfer draft with this in its place: on the model asked for (the submenu), else the one used last. */
  const transfer = useMutation({
    mutationFn: (id?: string) => {
      const to = movers.find((r) => r.id === id) ?? mover!;
      const slot = asset.kind === "image" ? pictureSlot(to)! : drivingSlot(to)!;
      aim(to, slot.id);
      return api.createDraft({ recipe: to.id, forms: { [to.id]: { [slot.id]: asset.kind === "image" ? asset.id : { asset: asset.id } } } });
    },
    onSuccess: toForm,
  });
  /** The models a submenu offers, the one used last first (marked), then by name; one not ready says so. */
  const choices = (ways: RecipeInfo[], last: RecipeInfo | undefined) => {
    // a model with two ways (H3's Video with audio and Lip sync both open on a picture) says which: "MiniMax H3 · Lip sync"
    const said = (r: RecipeInfo) => (ways.filter((w) => w.family === r.family).length > 1 ? `${nameOf(r)} · ${r.title}` : nameOf(r));
    return [...ways].sort((x, y) => Number(y === last) - Number(x === last) || said(x).localeCompare(said(y)))
      .map((r) => ({ id: r.id, name: said(r), last: r === last, ready: ready(r) }));
  };

  const all = (recipes.data?.recipes ?? []).filter((r) => on(r.family));
  /** The recipe for an operation: the one of the model the picture was made with when it has it, else one that is ready, else any. */
  const toolFor = (key: string): RecipeInfo | undefined =>
    toolOf(key, all, recipes.data?.families ?? [], madeWith?.id, (r) => Boolean(setup.data?.recipes.find((x) => x.id === r.id)?.ready));
  /** What a tool is handed with the picture in its source slot; `withLook`: its cast goes along too. */
  const toolInput = (tool: RecipeInfo, withLook = false) => {
    const slot = tool.inputs.find((i) => i.type === "image" && i.role === "source")!;
    return { ...carried(made, madeWith, tool, withLook), [slot.id]: asset.id };
  };
  /** A tool's form, with the picture in place and what it was made with. */
  const openTool = useMutation({
    mutationFn: (id: string) => {
      const tool = all.find((r) => r.id === id)!;
      const look = castOf(detail.data);
      aim(tool, tool.inputs.find((i) => i.type === "image" && i.role === "source")?.id);
      return api.createDraft({ recipe: tool.id, forms: { [tool.id]: toolInput(tool, Boolean(look)) }, look });
    },
    onSuccess: (d, id) => {
      // a tool that redoes a painted part (Inpaint) opens on its painter: painting the mask is the next step anyway
      if (all.find((r) => r.id === id)?.inputs.some((i) => i.type === "image" && i.role === "mask")) handMask(asset.id);
      toForm(d);
    },
  });

  return {
    a, g, recipe, madeWith, recipes, reuse, carrier, fromLastFrame, carryOn, between, extendHere, opener, openerName, animate, mover, moverName, transfer,
    openerChoices: choices(openers, opener), moverChoices: choices(movers, mover), follower, follow, toolFor, toolInput, openTool,
  };
}
