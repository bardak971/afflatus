import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clapperboard, Copy, Download, Eye, ExternalLink, Shuffle, SquareCheck, Star, Trash2, Undo2 } from "lucide-react";
import { api, fileUrl, type Asset, type RecipeInfo } from "./api";
import { ContextMenu, useMenu, type MenuItem } from "./ContextMenu";
import { useAsset, useFamilies, useModelSettings, useRecipes, useSetup } from "./data";
import { formDefaults } from "./form";
import { notReady } from "./format";
import { usedLast } from "./picker";
import { useBanners, useOpenDraft } from "./store";

const FORMATS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac" };

/**
 * The right-click menu of a library tile: what the viewer offers on the item, without opening it. Each
 * entry mirrors a button or a key of the viewer. What needs the item's generation parameters (Reuse,
 * Variation, Open in ComfyUI) is offered once they are read, which starts when the menu opens.
 */
export function useTileMenu({ onOpen, onSelect, into }: {
  onOpen(asset: Asset): void;
  /** Tick it, for a move / keep / bin of several. */
  onSelect?(asset: Asset): void;
  /** Where a variation queued from here lands. */
  into?: { draft?: string; folder?: string };
}) {
  const { menu, open, close } = useMenu<Asset>();
  const a = menu?.subject ?? null;
  const detail = useAsset(a?.id ?? null);
  const client = useQueryClient();
  const recipes = useRecipes();
  const setup = useSetup();
  const modelSettings = useModelSettings();
  const on = useFamilies().isOn;
  const drafts = useQuery({ queryKey: ["drafts"], queryFn: api.drafts, enabled: Boolean(a) });
  const openDraft = useOpenDraft((s) => s.open);
  const [, go] = useLocation();
  const say = useBanners((b) => b.push);
  const refresh = () => client.invalidateQueries({ queryKey: ["assets"] });

  const g = detail.data?.generation ?? null;
  const recipe = g ? recipes.data?.recipes.find((r) => r.id === g.recipe) : undefined;
  const all = (recipes.data?.recipes ?? []).filter((r) => on(r.family));
  const opener = usedLast(
    all.filter((r) => r.output === "video" && r.inputs.some((i) => i.type === "image" && i.role === "start")),
    drafts.data?.items,
    (r) => Boolean(setup.data?.recipes.find((x) => x.id === r.id)?.ready),
  );
  const toForm = (d: { id: string }) => {
    client.setQueryData(["drafts", d.id], d);
    void client.invalidateQueries({ queryKey: ["drafts"], exact: true });
    openDraft(d.id);
    go("/create");
  };
  const keep = useMutation({ mutationFn: (v: { id: string; kept: boolean }) => api.keep(v.id, v.kept), onSuccess: refresh });
  const bin = useMutation({ mutationFn: (id: string) => api.bin(id), onSuccess: refresh });
  const restore = useMutation({ mutationFn: (id: string) => api.restore(id), onSuccess: refresh });
  const animate = useMutation({
    mutationFn: (asset: Asset) => {
      const slot = opener!.inputs.find((i) => i.type === "image" && i.role === "start")!;
      return api.createDraft({ recipe: opener!.id, forms: { [opener!.id]: { [slot.id]: asset.id } }, look: detail.data?.look ?? null });
    },
    onSuccess: toForm,
  });
  const again = useMutation({
    mutationFn: () => api.createDraft({ recipe: g!.recipe, forms: { [g!.recipe]: { ...g!.inputs, seed: -1 } } }),
    onSuccess: toForm,
  });
  const variation = useMutation({
    mutationFn: async (r: RecipeInfo) => {
      const status = setup.data?.recipes.find((x) => x.id === r.id);
      const why = setup.isSuccess ? notReady(status, setup.data.comfy.online) : null;
      if (why) throw new Error(why);
      const stored = { ...g!.inputs, seed: -1 };
      const input: Record<string, unknown> = { ...formDefaults(r, status?.options, modelSettings.data?.items ?? [], stored).defaults, ...stored };
      const has = new Set(r.inputs.map((i) => i.id));
      for (const id of Object.keys(input)) if (input[id] === undefined || !has.has(id)) delete input[id];
      await api.enqueue(r.id, input, 1, null, into);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["queue"] });
      say({ id: `menu:${Date.now()}`, tone: "good", title: "Variation queued", href: "/queue", go: "Open queue" });
    },
    onError: (err) => say({ id: `menu:${Date.now()}`, tone: "bad", title: "Variation could not be queued", text: err.message, href: "/settings/models", go: "Open settings" }),
  });
  const openInComfy = useMutation({
    mutationFn: async (asset: Asset) => {
      const tab = window.open("", "_blank");
      try {
        const r = await api.openRender(asset.id);
        if (tab) tab.location.href = r.url;
        return r;
      } catch (err) {
        tab?.close();
        throw err;
      }
    },
    onSuccess: (r) => { if (!r.direct) say({ id: `menu:${Date.now()}`, tone: "good", title: "Saved in ComfyUI", text: `${r.path}: open the Workflows sidebar there (key W) and pick it under "afflatus".`, href: "/settings", go: "Open settings" }); },
    onError: (err) => say({ id: `menu:${Date.now()}`, tone: "bad", title: "Could not open in ComfyUI", text: err.message, href: "/settings", go: "Open settings" }),
  });
  const download = (asset: Asset) => {
    const link = document.createElement("a");
    link.href = fileUrl(asset.id);
    link.download = asset.name || `${asset.id}.${FORMATS[asset.mime] ?? "bin"}`;
    link.click();
  };

  const items = (asset: Asset): MenuItem[] => {
    const reading = detail.isLoading;
    return [
      { label: "Open", icon: <Eye size={14} />, run: () => onOpen(asset) },
      { label: asset.kept ? "Unkeep" : "Keep", key: "S", icon: <Star size={14} />, disabled: asset.inBin, run: () => keep.mutate({ id: asset.id, kept: !asset.kept }) },
      ...(onSelect ? [{ label: "Select", key: "Ctrl + Click", icon: <SquareCheck size={14} />, run: () => onSelect(asset) }] : []),
      "—" as const,
      ...(asset.kind === "image" && opener && !asset.inBin ? [{ label: "Image to video (i2v)", key: "M", icon: <Clapperboard size={14} />, note: opener.title, run: () => animate.mutate(asset) }] : []),
      { label: "Reuse parameters", key: "L", icon: <Copy size={14} />, disabled: reading || !g || !recipe, note: !reading && !g ? "not generated here" : undefined, run: () => again.mutate() },
      { label: "Variation", key: "V", icon: <Shuffle size={14} />, note: !reading && !g ? "not generated here" : "new seed, queued", disabled: reading || !g || !recipe || asset.inBin, run: () => recipe && variation.mutate(recipe) },
      { label: "Open in ComfyUI", icon: <ExternalLink size={14} />, disabled: reading || !g || !(setup.data?.comfy.online ?? false), run: () => openInComfy.mutate(asset) },
      "—" as const,
      { label: "Download", key: "D", icon: <Download size={14} />, run: () => download(asset) },
      asset.inBin
        ? { label: "Put back", icon: <Undo2 size={14} />, run: () => restore.mutate(asset.id) }
        : { label: "Move to the bin", key: "Del", icon: <Trash2 size={14} />, danger: true, run: () => bin.mutate(asset.id) },
    ];
  };

  const element = a && menu ? <ContextMenu at={menu.at} label={`Actions on this ${a.kind}`} items={items(a)} onClose={close} /> : null;
  return { open, element };
}
