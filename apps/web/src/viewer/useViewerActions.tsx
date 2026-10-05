import type { Dispatch, RefObject, SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Clapperboard, Download, Scissors, Shuffle, Star, Trash2, Wand2 } from "lucide-react";
import { secondsInput } from "@afflatus/core";
import type { Range } from "../Trim";
import { useQueueVariation } from "../actions";
import { askAboutDisk } from "../Confirm";
import { api, fileUrl, type Asset, type AssetDetail, type RecipeInfo, type Look } from "../api";
import { useAssetAction, useFamilies, useRecipes, useSetup, type useAsset } from "../data";
import { useOpenNewDraft } from "../draft";
import { carryOver, followOn, modelGroups, usedLast } from "../picker";
import { useBanners } from "../store";
import type { MenuItem } from "../ContextMenu";
import { FORMATS, OPS } from "./shared";

/** What a tool is handed along with a picture: what the picture was made with (its prompt, model, LoRAs…), where the tool has a place for it. */
function carried(g: AssetDetail["generation"] | null | undefined, from: RecipeInfo | undefined, to: RecipeInfo): Record<string, unknown> {
  if (!g || !from) return {};
  // the picture is the new source; its own source, mask and seed stay behind
  const taken = carryOver(from, to, g.inputs, undefined);
  for (const i of to.inputs) if (i.type === "image" || i.type === "seed") delete taken[i.id];
  return taken;
}

/**
 * Who a new draft made from this starts with: the people, the places and the style it was made with.
 * (Not its ticked snippets: those were bits of text for the model it was made with.)
 */
const castOf = (d: AssetDetail | undefined): Look | null => (d?.id && d.look && (d.look.cast.length || d.look.style) ? { cast: d.look.cast, style: d.look.style ?? null, snippets: [] } : null);

/** Everything the viewer does to the item: its mutations, the tools by key, the menus, and the item as it is known. */
export function useViewerActions({ asset, first, trailed, items, detail, into, inline, player, trim, setTrim, setInfo, onOpen, onClose, onOpened }: {
  /** The item shown: the end of the trail, or the one the viewer was opened on. */
  asset: Asset;
  /** The item the viewer was opened on, whose place in `items` the arrows step from. */
  first: Asset;
  /** "Made from" or "used to make" was followed: the arrows no longer step through the list. */
  trailed: boolean;
  /** The list it was opened from: the arrow keys go to the item before and after. */
  items?: Asset[];
  detail: ReturnType<typeof useAsset>;
  /** What is queued from here belongs to this draft and lands in this folder. */
  into?: { draft?: string; folder?: string };
  /** Drawn in place: the viewer stays when a form opens. */
  inline?: boolean;
  player: RefObject<HTMLVideoElement | null>;
  trim: boolean;
  setTrim: Dispatch<SetStateAction<boolean>>;
  setInfo: Dispatch<SetStateAction<boolean>>;
  onOpen?(asset: Asset): void;
  onClose(): void;
  /** An item made here (a frame, a sound), shown in its turn. */
  onOpened(asset: Asset): void;
}) {
  // where the video cuts between shots: read when Trim opens, kept
  const scenes = useQuery({ queryKey: ["scenes", asset.id], queryFn: () => api.scenes(asset.id), enabled: trim && asset.kind === "video", staleTime: Infinity });
  const everyScene = useMutation({
    mutationFn: async (v: { cuts: number[]; crf: number }) => {
      const edges = [0, ...v.cuts, asset.durationMs ?? 0];
      for (let i = 0; i + 1 < edges.length; i++) {
        if (edges[i + 1]! - edges[i]! < 200) continue;
        await api.range(asset.id, { startMs: edges[i]!, endMs: edges[i + 1]!, action: "copy", crf: v.crf });
      }
    },
  });
  const recipes = useRecipes();
  const keep = useAssetAction((kept: boolean) => api.keep(asset.id, kept));
  const bin = useAssetAction(() => api.bin(asset.id));
  const restore = useAssetAction(() => api.restore(asset.id));
  const client = useQueryClient();
  /** Over the screen, it steps aside when one of its actions opens a form: the form is what is looked at next. */
  const leave = () => {
    if (!inline) onClose();
  };
  const openNew = useOpenNewDraft();
  const toForm = (d: Awaited<ReturnType<typeof api.createDraft>>) => {
    leave();
    openNew(d);
  };
  const g = detail.data?.id === asset.id ? detail.data.generation : null;
  const a: Asset = detail.data?.id === asset.id ? detail.data : asset;
  const recipe = recipes.data?.recipes.find((r) => r.id === g?.recipe);
  /** The same settings with a new seed, as a new draft: what is being written elsewhere is not touched. */
  const again = useMutation({
    mutationFn: (g: NonNullable<AssetDetail["generation"]>) => api.createDraft({ recipe: g.recipe, forms: { [g.recipe]: { ...g.inputs, seed: -1 } } }),
    onSuccess: toForm,
  });

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
      const settings = followOn(recipe, to, g?.inputs);
      const slot = joins(to);
      if (slot) return api.createDraft({ recipe: to.id, forms: { [to.id]: { ...settings, [slot.id]: { asset: asset.id } } }, look: castOf(detail.data) });
      // past its end, the last frame that can be read is the one taken
      const last = await api.frame(asset.id, a.durationMs ?? 0);
      void client.invalidateQueries({ queryKey: ["assets"] });
      return api.createDraft({ recipe: to.id, forms: { [to.id]: { ...settings, [opensOn(to)!.id]: last.id } }, look: castOf(detail.data) });
    },
    onSuccess: toForm,
  });

  /** A new clip from the frame at in to the frame at out, on the video model used last: first frame, last frame, duration = the range. */
  const between = useMutation({
    mutationFn: async (range: Range) => {
      const to = opener!;
      const first = await api.frame(asset.id, Math.round(range.startMs));
      const last = await api.frame(asset.id, Math.round(range.endMs));
      void client.invalidateQueries({ queryKey: ["assets"] });
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
      const settings = carrier ? followOn(recipe, to, g?.inputs) : {};
      const slot = carrier ? joins(to) : null;
      if (slot) return api.createDraft({ recipe: to.id, forms: { [to.id]: { ...settings, [slot.id]: { asset: asset.id, at: Math.round(atMs) } } }, look: castOf(detail.data) });
      const frame = await api.frame(asset.id, Math.round(atMs));
      void client.invalidateQueries({ queryKey: ["assets"] });
      const start = to.inputs.find((i) => i.type === "image" && i.role === "start")!;
      return api.createDraft({ recipe: to.id, forms: { [to.id]: { ...settings, [start.id]: frame.id } }, look: castOf(detail.data) });
    },
    onSuccess: toForm,
  });

  // a picture as the first frame of a new video: a draft on the video model used last among those that can
  // open on a picture (the form can still be put on another one: the picture goes along)
  const setup = useSetup();
  const drafts = useQuery({ queryKey: ["drafts"], queryFn: api.drafts });
  const opener = usedLast(
    (recipes.data?.recipes ?? []).filter((r) => on(r.family) && r.output === "video" && r.inputs.some((i) => i.type === "image" && i.role === "start")),
    drafts.data?.items,
    (r) => Boolean(setup.data?.recipes.find((x) => x.id === r.id)?.ready),
  );
  const openerName = opener ? (recipes.data?.families.find((f) => f.id === opener.family)?.name ?? opener.title) : "";
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
  // what a video gives besides itself: the frame it is paused on, and its sound; both open here once made
  const opened = (a: Asset) => {
    void client.invalidateQueries({ queryKey: ["assets"] });
    onOpened(a);
  };
  const saveFrame = useMutation({ mutationFn: () => api.frame(asset.id, Math.round((player.current?.currentTime ?? 0) * 1000)), onSuccess: opened });
  const takeSound = useMutation({ mutationFn: () => api.takeSound(asset.id), onSuccess: opened });
  // a frame at a moment picked in Trim: opened here once made
  const frameAt = useMutation({ mutationFn: (atMs: number) => api.frame(asset.id, Math.round(atMs)), onSuccess: opened });
  // the range as new videos: a job of the queue; the library shows them when it is done
  const cutRange = useMutation({
    mutationFn: (v: { range: Range; action: "copy" | "split" | "remove" | "slow"; crf: number; factor?: 2 | 4 }) => api.range(asset.id, { startMs: Math.round(v.range.startMs), endMs: Math.round(v.range.endMs), action: v.action, crf: v.crf, factor: v.factor }),
    onSuccess: (r, v) => {
      void client.invalidateQueries({ queryKey: ["queue"] });
      // Trim stays open: the next action may follow on the same range
      if (v.action === "slow") {
        say({ id: `cut:${Date.now()}`, tone: "good", title: `Slowing the range ×${v.factor ?? 2}`, text: `${r.engine === "rife" ? "RIFE on the GPU, through the queue." : "ffmpeg's motion interpolation on the processor: slow, minutes for a few seconds. For RIFE on the GPU, put a RIFE model in ComfyUI's models/frame_interpolation folder with the frame interpolation nodes."} The new video, its sound slowed with it, shows in the library when it is done.`, href: "/queue", go: "Open queue" });
        return;
      }
      say({ id: `cut:${Date.now()}`, tone: "good", title: v.action === "copy" ? "Copying the range to your library" : v.action === "split" ? "Splitting the video" : "Removing the range", text: `In the queue; it needs no GPU. The new video${v.action === "split" ? "s show" : " shows"} in the library when it is done${v.action === "copy" ? "" : "; this one goes to the bin then"}.`, href: "/queue", go: "Open queue" });
    },
  });

  // ---- what the keys do
  const say = useBanners((b) => b.push);
  const all = (recipes.data?.recipes ?? []).filter((r) => on(r.family));
  /** The recipe for an operation: the one of the model the picture was made with when it has it, else one that is ready, else any. */
  const toolFor = (key: string): RecipeInfo | undefined => {
    const ends = OPS[key]?.ends ?? [];
    const fits = (r: RecipeInfo) => r.output === "image" && ends.some((e) => r.id.endsWith(e));
    const mine = modelGroups(all.filter((r) => r.output === "image"), recipes.data?.families ?? []).find((group) => group.recipes.some((r) => r.id === recipe?.id));
    const ready = (r: RecipeInfo) => setup.data?.recipes.find((x) => x.id === r.id)?.ready;
    return mine?.recipes.find(fits) ?? all.find((r) => fits(r) && ready(r)) ?? all.find(fits);
  };
  /** A tool's form, with the picture in place and what it was made with. */
  const openTool = useMutation({
    mutationFn: (id: string) => {
      const tool = all.find((r) => r.id === id)!;
      const slot = tool.inputs.find((i) => i.type === "image" && i.role === "source")!;
      return api.createDraft({ recipe: tool.id, forms: { [tool.id]: { ...carried(g, recipe, tool), [slot.id]: asset.id } }, look: castOf(detail.data) });
    },
    onSuccess: toForm,
  });
  /** Queue something at once, and say so. */
  const queued = useQueueVariation(into);
  const quick = (key: string) => {
    const tool = toolFor(key);
    if (!tool) return;
    const slot = tool.inputs.find((i) => i.type === "image" && i.role === "source")!;
    queued.mutate({ recipe: tool, stored: { ...carried(g, recipe, tool), [slot.id]: asset.id }, label: OPS[key]!.label });
  };
  /** The item before or after in the list it was opened from. */
  const at = !trailed && items ? items.findIndex((x) => x.id === first.id) : -1;
  const move = (by: -1 | 1) => {
    const next = at >= 0 ? items![at + by] : undefined;
    if (next) onOpen?.(next);
    return Boolean(next);
  };
  const toBin = async () => {
    // a file of a linked folder leaves its folder on the disk: asked first
    if (!(await askAboutDisk([a]))) return;
    bin.mutate(undefined);
    // on to the next one: sorting a batch is keep, bin, keep, bin
    if (!(move(1) || move(-1))) onClose();
  };
  const download = () => {
    const link = document.createElement("a");
    link.href = fileUrl(asset.id);
    link.download = a.name || `${asset.id}.${(FORMATS[a.mime] ?? "bin").toLowerCase()}`;
    link.click();
  };

  const videoItems = (): MenuItem[] => [
    { label: a.kept ? "Unkeep" : "Keep", key: "S", icon: <Star size={14} />, run: () => keep.mutate(!a.kept) },
    { label: "Download the file", key: "D", icon: <Download size={14} />, run: download },
    ...(g && recipe ? [
      { label: "Variation: same parameters, new seed", key: "V", icon: <Shuffle size={14} />, run: () => queued.mutate({ recipe, stored: { ...g.inputs, seed: -1 }, label: "Variation" }) },
      { label: "Reuse parameters in the form", key: "L", icon: <Wand2 size={14} />, run: () => again.mutate(g) },
    ] : []),
    "—" as const,
    { label: "Save this frame as an image", key: "G", icon: <Camera size={14} />, run: () => saveFrame.mutate() },
    ...(!a.inBin ? [{ label: trim ? "Close Trim" : "Trim: pick a range", key: "T", icon: <Scissors size={14} />, run: () => setTrim(!trim) }] : []),
    ...(carrier ? [{ label: "Extend: a new clip that carries on", key: "C", icon: <Clapperboard size={14} />, run: () => carryOn.mutate() }] : []),
    "—" as const,
    { label: "Move to the bin", key: "Del", icon: <Trash2 size={14} />, danger: true, run: () => void toBin() },
  ];
  /** The picture's menu: every action its buttons and keys offer. */
  const imageItems = (): MenuItem[] => [
    { label: a.kept ? "Unkeep" : "Keep", key: "S", icon: <Star size={14} />, run: () => keep.mutate(!a.kept) },
    { label: "Download the file", key: "D", icon: <Download size={14} />, run: download },
    ...(g && recipe ? [
      { label: "Variation: same parameters, new seed", key: "V", icon: <Shuffle size={14} />, run: () => queued.mutate({ recipe, stored: { ...g.inputs, seed: -1 }, label: "Variation" }) },
      { label: "Reuse parameters in the form", key: "L", icon: <Wand2 size={14} />, run: () => again.mutate(g) },
    ] : []),
    ...(!g ? [{ label: "Details", key: "P", run: () => setInfo(true) }] : []),
    "—" as const,
    ...(opener && !a.inBin ? [{ label: `Make a video of it (${openerName})`, key: "M", icon: <Clapperboard size={14} />, run: () => animate.mutate() }] : []),
    ...(a.inBin ? [] : ["u", "f", "b"].flatMap((k) => (toolFor(k) ? [{ label: `${OPS[k]!.label}: queued now`, key: k.toUpperCase(), run: () => quick(k) }] : []))),
    ...(a.inBin ? [] : ["i", "e", "r"].flatMap((k) => {
      const tool = toolFor(k);
      return tool ? [{ label: `${tool.title}: open its form`, key: k.toUpperCase(), run: () => openTool.mutate(tool.id) }] : [];
    })),
    "—" as const,
    { label: "Move to the bin", key: "Del", icon: <Trash2 size={14} />, danger: true, run: () => void toBin() },
  ];

  return { a, g, recipe, recipes, scenes, everyScene, keep, restore, leave, again, carrier, fromLastFrame, carryOn, between, extendHere, opener, openerName, animate, follower, follow, saveFrame, takeSound, frameAt, cutRange, toolFor, openTool, queued, quick, at, move, toBin, download, videoItems, imageItems };
}

/** What `useViewerActions` gives: handed whole to the parts of the viewer. */
export type ViewerActions = ReturnType<typeof useViewerActions>;
