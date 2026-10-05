import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clapperboard, Copy, Download, ExternalLink, Eye, Film, FolderKanban, Pencil, Plus, Shuffle, SquareCheck, Star, Trash2, Undo2 } from "lucide-react";
import { useAddToLast, useAddToTimeline, useLast, useOpenInComfy, useQueueVariation, useStartTimeline } from "./actions";
import { api, fileUrl, thumbUrl, type Asset } from "./api";
import { askText } from "./Confirm";
import { ContextMenu, useMenu, type MenuItem } from "./ContextMenu";
import { useAsset, useDrafts, useFamilies, useProjects, useRecipes, useSetup, useTimelines } from "./data";
import { Dialog } from "./Dialog";
import { useOpenNewDraft } from "./draft";
import { useState } from "react";
import { Button, ErrorNote } from "./ui";
import { clock, when } from "./format";
import { usedLast } from "./picker";
import { useBanners } from "./store";

const FORMATS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac" };

/**
 * The right-click menu of a library tile: what the viewer offers on the item, without opening it. Each
 * entry mirrors a button or a key of the viewer. What needs the item's generation parameters (Reuse,
 * Variation, Open in ComfyUI) is offered once they are read, which starts when the menu opens.
 */
export function useTileMenu({ onOpen, onSelect, into, first }: {
  onOpen(asset: Asset): void;
  /** What the place the menu opens in does with the item, before everything else (the editor's library: add it to the timeline). */
  first?(asset: Asset): MenuItem[];
  /** Tick it, for a move / keep / bin of several. */
  onSelect?(asset: Asset): void;
  /** Where a variation queued from here lands. */
  into?: { draft?: string; folder?: string };
}) {
  const { menu, open, close } = useMenu<Asset>();
  const a = menu?.subject ?? null;
  const detail = useAsset(a?.id ?? null);
  const client = useQueryClient();
  // a name of the user's own, asked for in a box; the library shows it and the search goes by it
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.renameAsset(v.id, v.name), onSuccess: (_, v) => { void client.invalidateQueries({ queryKey: ["assets"] }); void client.invalidateQueries({ queryKey: ["asset", v.id] }); } });
  const renameIt = async (of: Asset) => {
    const name = await askText({ title: "Rename", value: of.name, placeholder: "A name for it", yes: "Rename" });
    if (name !== null && name !== of.name) rename.mutate({ id: of.id, name });
  };
  const recipes = useRecipes();
  const setup = useSetup();
  const on = useFamilies().isOn;
  const drafts = useDrafts(Boolean(a));
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
  const toForm = useOpenNewDraft();
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
  const variation = useQueueVariation(into);
  const openInComfy = useOpenInComfy((asset: Asset) => api.openRender(asset.id), {
    onSuccess: (r) => { if (!r.direct) say({ id: `menu:${Date.now()}`, tone: "good", title: "Saved in ComfyUI", text: `${r.path}: open the Workflows sidebar there (key W) and pick it under "afflatus".`, href: "/settings", go: "Open settings" }); },
    onError: (err) => say({ id: `menu:${Date.now()}`, tone: "bad", title: "Could not open in ComfyUI", text: err.message, href: "/settings", go: "Open settings" }),
  });
  /** The dialog that adds the item to a timeline: which one, or a new one. */
  const [adding, setAdding] = useState<Asset | null>(null);
  const [, go] = useLocation();
  const last = useLast();
  const addToLast = useAddToLast();
  const start = useStartTimeline({ onSuccess: (t) => go(`/timelines/${t.id}`) });
  // the projects, to move an item into another's root folder (or out of every project, into the Inbox)
  const projects = (useProjects().data?.items ?? []).filter((p) => !p.archivedAt);
  const moveTo = useMutation({
    mutationFn: (v: { ids: string[]; folder: string | null }) => api.moveAssets(v.ids, v.folder),
    onSuccess: () => {
      // the folders' counts are under "assets" (data.ts): one invalidation covers the lists and them
      void client.invalidateQueries({ queryKey: ["assets"] });
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
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
      ...(first?.(asset) ?? []),
      { label: "Open", icon: <Eye size={14} />, run: () => onOpen(asset) },
      { label: asset.kept ? "Unkeep" : "Keep", key: "S", icon: <Star size={14} />, disabled: asset.inBin, run: () => keep.mutate({ id: asset.id, kept: !asset.kept }) },
      ...(onSelect ? [{ label: "Select", key: "Ctrl + Click", icon: <SquareCheck size={14} />, run: () => onSelect(asset) }] : []),
      "—" as const,
      ...(asset.kind === "image" && opener && !asset.inBin ? [{ label: "Image to video (i2v)", key: "M", icon: <Clapperboard size={14} />, note: opener.title, run: () => animate.mutate(asset) }] : []),
      { label: "Reuse parameters", key: "L", icon: <Copy size={14} />, disabled: reading || !g || !recipe, note: !reading && !g ? "not generated here" : undefined, run: () => again.mutate() },
      { label: "Variation", key: "V", icon: <Shuffle size={14} />, note: !reading && !g ? "not generated here" : "new seed, queued", disabled: reading || !g || !recipe || asset.inBin, run: () => recipe && g && variation.mutate({ recipe, stored: { ...g.inputs, seed: -1 }, label: "Variation" }) },
      { label: "Open in ComfyUI", icon: <ExternalLink size={14} />, disabled: reading || !g || !(setup.data?.comfy.online ?? false), run: () => openInComfy.mutate(asset) },
      ...(asset.kind !== "audio" && !asset.inBin
        ? [
            ...(last ? [{ label: `Add to ${last.name}`, key: "A", icon: <Film size={14} />, note: "the timeline you last added to", run: () => addToLast.mutate(asset) }] : []),
            { label: "Add to a timeline…", icon: <Film size={14} />, note: asset.kind === "image" ? "at the end, as a still" : "at the end", run: () => setAdding(asset) },
            { label: "Start a timeline from it", key: "N", icon: <Film size={14} />, note: asset.kind === "image" ? "clip 1 opens on this picture" : "clip 1 is this video", run: () => start.mutate(asset) },
          ]
        : []),
      ...(projects.length && !asset.inBin
        ? [
            "—" as const,
            ...projects.map((p): MenuItem => ({ label: `Move to ${p.name}`, icon: <FolderKanban size={14} />, note: "its root folder", disabled: asset.folderId === p.folderId, run: () => moveTo.mutate({ ids: [asset.id], folder: p.folderId }) })),
            { label: "Move to the Inbox", icon: <FolderKanban size={14} />, note: "out of every project", disabled: asset.folderId === null, run: () => moveTo.mutate({ ids: [asset.id], folder: null }) },
          ]
        : []),
      "—" as const,
      { label: "Rename…", icon: <Pencil size={14} />, run: () => void renameIt(asset) },
      { label: "Download", key: "D", icon: <Download size={14} />, run: () => download(asset) },
      asset.inBin
        ? { label: "Put back", icon: <Undo2 size={14} />, run: () => restore.mutate(asset.id) }
        : { label: "Move to the bin", key: "Del", icon: <Trash2 size={14} />, danger: true, run: () => bin.mutate(asset.id) },
    ];
  };

  const element = (
    <>
      {a && menu && <ContextMenu at={menu.at} label={`Actions on this ${a.kind}`} items={items(a)} onClose={close} />}
      {adding && <AddToTimeline asset={adding} onClose={() => setAdding(null)} />}
    </>
  );
  return { open, element };
}

/** Which timeline an item goes to the end of: one of the project's, or a new one. */
function AddToTimeline({ asset, onClose }: { asset: Asset; onClose(): void }) {
  const timelines = useTimelines();
  const [, go] = useLocation();
  const say = useBanners((b) => b.push);
  const add = useAddToTimeline(asset, {
    onSuccess: (target) => {
      say({ id: `add:${Date.now()}`, tone: "good", title: `Added to ${target.name}`, text: asset.kind === "image" ? "At the end, as a still." : "At the end.", href: `/timelines/${target.id}`, go: "Open the timeline" });
      onClose();
    },
  });
  const items = timelines.data?.items ?? [];
  return (
    <Dialog label="Add to a timeline" onClose={onClose} z="z-50" className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-line-strong bg-panel p-5">
        <span className="text-base font-semibold">Add to a timeline</span>
        <span className="text-xs text-ink-2">{asset.kind === "image" ? "The image goes at the end, as a still you can animate or hold." : "The video goes at the end, as a clip of its own."}</span>
        {add.isError && <ErrorNote>{add.error.message}</ErrorNote>}
        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {items.map((t) => (
            <button key={t.id} type="button" disabled={add.isPending} onClick={() => add.mutate(t.id)} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-left hover:border-accent">
              {t.cover ? <img src={thumbUrl(t.cover)} alt="" className="h-9 w-14 rounded object-cover" /> : <span className="flex h-9 w-14 items-center justify-center rounded bg-raised text-ink-3"><Film size={14} /></span>}
              <span className="flex min-w-0 grow flex-col">
                <span className="truncate font-semibold">{t.name}</span>
                <span className="text-xs text-ink-2">{t.clips === 0 ? "Empty" : `${t.clips} clip${t.clips > 1 ? "s" : ""}${t.durationMs ? ` · ${clock(t.durationMs)}` : ""}`} · {when(t.updatedAt)}</span>
              </span>
            </button>
          ))}
          {timelines.isSuccess && !items.length && <span className="text-ink-2">No timeline here yet.</span>}
        </div>
        <div className="flex gap-2">
          <Button tone="primary" disabled={add.isPending} onClick={() => add.mutate(null)}><Plus size={14} strokeWidth={2.6} /> New timeline with it</Button>
          <Button tone="quiet" onClick={onClose}>Cancel</Button>
          <span className="grow" />
          <Button size="sm" tone="quiet" onClick={() => { onClose(); go("/timelines"); }}>All timelines</Button>
        </div>
    </Dialog>
  );
}
