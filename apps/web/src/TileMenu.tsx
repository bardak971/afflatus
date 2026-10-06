import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clapperboard, Copy, Download, ExternalLink, Eye, Film, FolderKanban, MoreHorizontal, Pencil, Plus, Search, Shuffle, SquareCheck, Star, Trash2, Undo2 } from "lucide-react";
import { useAddTo, useAddToTimeline, useLast, useOpenInComfy, useQueueVariation, useStartTimeline } from "./actions";
import { api, fileUrl, thumbUrl, type Asset } from "./api";
import { askText } from "./Confirm";
import { ContextMenu, useMenu, type MenuItem } from "./ContextMenu";
import { formPlaces, useFormTarget } from "./formTarget";
import { useAsset, useDrafts, useFamilies, useFolders, useProjects, useRecipes, useSetup, useTimelines } from "./data";
import { useStudio } from "./screens/Studio";
import { useProject } from "./project";
import { Select } from "./Select";
import { fuzzyScore } from "@afflatus/core";
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
export function useTileMenu({ onOpen, onSelect, into, first, compact }: {
  onOpen(asset: Asset): void;
  /** Inside an editor: what the Studio does with an item (i2v, reuse, timelines, projects) folds into one "More" submenu. */
  compact?: boolean;
  /** What the place the menu opens in does with the item, before everything else (the editor's library: add it to the timeline). */
  first?(asset: Asset): MenuItem[];
  /** Tick it, for a move / keep / bin of several. */
  onSelect?(asset: Asset): void;
  /** Where a variation queued from here lands. */
  into?: { draft?: string; folder?: string };
}) {
  const { menu, open, close } = useMenu<Asset>();
  const formTarget = useFormTarget((st) => st.target);
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
  const timelineMenu = useTimelineSubmenu();
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
    const studio: MenuItem[] = [
      ...(asset.kind === "image" && opener && !asset.inBin ? [{ label: "Image to video (i2v)", key: "M", icon: <Clapperboard size={14} />, note: opener.title, run: () => animate.mutate(asset) }] : []),
      { label: "Reuse parameters", key: "L", icon: <Copy size={14} />, disabled: reading || !g || !recipe, note: !reading && !g ? "not generated here" : undefined, run: () => again.mutate() },
      { label: "Variation", key: "V", icon: <Shuffle size={14} />, note: !reading && !g ? "not generated here" : "new seed, queued", disabled: reading || !g || !recipe || asset.inBin, run: () => recipe && g && variation.mutate({ recipe, stored: { ...g.inputs, seed: -1 }, label: "Variation" }) },
      { label: "Open in ComfyUI", icon: <ExternalLink size={14} />, disabled: reading || !g || !(setup.data?.comfy.online ?? false), run: () => openInComfy.mutate(asset) },
      ...timelineMenu.items(asset),
      ...(projects.length && !asset.inBin
        ? [{ label: "Move to", icon: <FolderKanban size={14} />, note: "another project", items: [
            ...projects.map((p): MenuItem => ({ label: p.name, icon: <FolderKanban size={14} />, note: "its root folder", disabled: asset.folderId === p.folderId, run: () => moveTo.mutate({ ids: [asset.id], folder: p.folderId }) })),
            { label: "The Inbox", icon: <FolderKanban size={14} />, note: "out of every project", disabled: asset.folderId === null, run: () => moveTo.mutate({ ids: [asset.id], folder: null }) },
          ] }]
        : []),
    ];
    const places = compact ? [] : formPlaces(formTarget, asset);
    return [
      ...(first?.(asset) ?? []),
      ...(places.length ? [{ label: "Use in this draft", icon: <Plus size={14} />, note: formTarget?.recipe.title, items: places }, "—" as const] : []),
      { label: "Open", icon: <Eye size={14} />, run: () => onOpen(asset) },
      { label: asset.kept ? "Unkeep" : "Keep", key: "S", icon: <Star size={14} />, disabled: asset.inBin, run: () => keep.mutate({ id: asset.id, kept: !asset.kept }) },
      ...(onSelect ? [{ label: "Select", key: "Ctrl + Click", icon: <SquareCheck size={14} />, run: () => onSelect(asset) }] : []),
      ...(compact ? [] : ["—" as const, ...studio]),
      "—" as const,
      { label: "Rename…", icon: <Pencil size={14} />, run: () => void renameIt(asset) },
      { label: "Download", key: "D", icon: <Download size={14} />, run: () => download(asset) },
      asset.inBin
        ? { label: "Put back", icon: <Undo2 size={14} />, run: () => restore.mutate(asset.id) }
        : { label: "Move to the bin", key: "Del", icon: <Trash2 size={14} />, danger: true, run: () => bin.mutate(asset.id) },
      ...(compact ? ["—" as const, { label: "More", icon: <MoreHorizontal size={14} />, note: "i2v, reuse, timelines, projects", items: studio.filter((it, i, all) => it !== "—" || (i > 0 && i < all.length - 1 && all[i - 1] !== "—")) }] : []),
    ];
  };

  const element = (
    <>
      {a && menu && <ContextMenu at={menu.at} label={`Actions on this ${a.kind}`} items={items(a)} onClose={close} />}
      {timelineMenu.element}
    </>
  );
  return { open, element };
}

/**
 * The Timeline submenu, the same in every menu of an item (the library's tiles, the stage, the viewer): the
 * recent timelines of the project straight, one click adding the item at the end (the last one used first, on A);
 * any other through a dialog with a search and the folders; or a new timeline from it. Pictures and videos only.
 */
export function useTimelineSubmenu(opts: { onStarted?(): void } = {}) {
  const timelines = useTimelines();
  const last = useLast();
  const [adding, setAdding] = useState<Asset | null>(null);
  const [, go] = useLocation();
  const addTo = useAddTo();
  const start = useStartTimeline({ onSuccess: (t) => { opts.onStarted?.(); go(`/timelines/${t.id}`); } });
  const items = (asset: Asset): MenuItem[] => {
    if (asset.kind === "audio" || asset.inBin) return [];
    const recent = [...(timelines.data?.items ?? [])]
      .sort((x, y) => (x.id === last?.id ? -1 : y.id === last?.id ? 1 : y.updatedAt.localeCompare(x.updatedAt)))
      .slice(0, 5);
    const end = asset.kind === "image" ? "at the end, as a still" : "at the end";
    return [{
      label: "Timeline", icon: <Film size={14} />, note: last ? `last: ${last.name}` : undefined, items: [
        ...recent.map((t): MenuItem => ({
          label: `Add to ${t.name}`, key: t.id === last?.id ? "A" : undefined, icon: <Film size={14} />,
          note: t.id === last?.id ? `last used · ${end}` : `${t.clips} clip${t.clips === 1 ? "" : "s"} · ${when(t.updatedAt)}`,
          disabled: addTo.isPending, run: () => addTo.mutate({ asset, timeline: t }),
        })),
        ...(recent.length ? ["—" as const] : []),
        { label: recent.length ? "Another timeline…" : "Add to a timeline…", icon: <Search size={14} />, note: "search, by folder", run: () => setAdding(asset) },
        { label: "Start a timeline from it", key: "N", icon: <Plus size={14} />, note: asset.kind === "image" ? "clip 1 opens on this picture" : "clip 1 is this video", run: () => start.mutate(asset) },
      ],
    }];
  };
  const element = adding ? <AddToTimeline asset={adding} onClose={() => setAdding(null)} /> : null;
  // the keys of the viewer (N, A) do what the submenu does
  const startFrom = (asset: Asset) => start.mutate(asset);
  const addToLast = last ? (asset: Asset) => addTo.mutate({ asset, timeline: last }) : null;
  return { items, element, startFrom, addToLast };
}

/**
 * What a tile's menu offers besides the viewer's own actions, for the viewer's and the stage's menus: the open
 * form ("Use in this draft"), first; then ComfyUI, another project and a name of its own, before the bin.
 */
export function useItemExtras() {
  const client = useQueryClient();
  const formTarget = useFormTarget((st) => st.target);
  const setup = useSetup();
  const say = useBanners((b) => b.push);
  const projects = (useProjects().data?.items ?? []).filter((p) => !p.archivedAt);
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.renameAsset(v.id, v.name), onSuccess: (_, v) => { void client.invalidateQueries({ queryKey: ["assets"] }); void client.invalidateQueries({ queryKey: ["asset", v.id] }); } });
  const moveTo = useMutation({
    mutationFn: (v: { ids: string[]; folder: string | null }) => api.moveAssets(v.ids, v.folder),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["assets"] });
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const openInComfy = useOpenInComfy((asset: Asset) => api.openRender(asset.id), {
    onSuccess: (r) => { if (!r.direct) say({ id: `menu:${Date.now()}`, tone: "good", title: "Saved in ComfyUI", text: `${r.path}: open the Workflows sidebar there (key W) and pick it under "afflatus".`, href: "/settings", go: "Open settings" }); },
    onError: (err) => say({ id: `menu:${Date.now()}`, tone: "bad", title: "Could not open in ComfyUI", text: err.message, href: "/settings", go: "Open settings" }),
  });
  /** "Use in this draft", when a form is open and takes it. */
  const first = (asset: Asset): MenuItem[] => {
    const places = formPlaces(formTarget, asset);
    return places.length ? [{ label: "Use in this draft", icon: <Plus size={14} />, note: formTarget?.recipe.title, items: places }, "—"] : [];
  };
  /** ComfyUI (a render made here), another project, a name. */
  const more = (asset: Asset, generated: boolean): MenuItem[] => [
    ...(generated ? [{ label: "Open in ComfyUI", icon: <ExternalLink size={14} />, disabled: !(setup.data?.comfy.online ?? false), note: setup.data?.comfy.online ? undefined : "ComfyUI is offline", run: () => openInComfy.mutate(asset) }] : []),
    ...(projects.length && !asset.inBin
      ? [{ label: "Move to", icon: <FolderKanban size={14} />, note: "another project", items: [
          ...projects.map((p): MenuItem => ({ label: p.name, icon: <FolderKanban size={14} />, note: "its root folder", disabled: asset.folderId === p.folderId, run: () => moveTo.mutate({ ids: [asset.id], folder: p.folderId }) })),
          { label: "The Inbox", icon: <FolderKanban size={14} />, note: "out of every project", disabled: asset.folderId === null, run: () => moveTo.mutate({ ids: [asset.id], folder: null }) },
        ] }]
      : []),
    { label: "Rename…", icon: <Pencil size={14} />, run: async () => {
      const name = await askText({ title: "Rename", value: asset.name, placeholder: "A name for it", yes: "Rename" });
      if (name !== null && name !== asset.name) rename.mutate({ id: asset.id, name });
    } },
  ];
  return { first, more };
}

/** Which timeline an item goes to the end of: one of the project's, or a new one. */
function AddToTimeline({ asset, onClose }: { asset: Asset; onClose(): void }) {
  const timelines = useTimelines();
  const folderList = useFolders();
  // the folder the Studio looks at, to begin with: its timelines are the likely ones
  const place = useStudio((st) => st.place);
  const [folder, setFolder] = useState<string>(place.type === "folder" ? place.id : "any");
  const [typed, setTyped] = useState("");
  const [, go] = useLocation();
  const say = useBanners((b) => b.push);
  const add = useAddToTimeline(asset, {
    onSuccess: (target) => {
      say({ id: `add:${Date.now()}`, tone: "good", title: `Added to ${target.name}`, text: asset.kind === "image" ? "At the end, as a still." : "At the end.", href: `/timelines/${target.id}`, go: "Open the timeline" });
      onClose();
    },
  });
  // the folders of the project the rail looks at, as the Studio's own folder list shows them (All: every one)
  const project = useProject((st) => st.id);
  const folders = (folderList.data?.items ?? []).filter((x) => !x.path && (project === null || (project === "none" ? x.projectId === null : x.projectId === project)));
  const items = (timelines.data?.items ?? [])
    .filter((t) => folder === "any" || (folder === "root" ? t.folderId === null : t.folderId === folder))
    .filter((t) => !typed.trim() || fuzzyScore(typed.trim(), t.name) !== null);
  return (
    <Dialog label="Add to a timeline" onClose={onClose} z="z-50" className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-line-strong bg-panel p-5">
        <span className="text-base font-semibold">Add to a timeline</span>
        <span className="text-xs text-ink-2">{asset.kind === "image" ? "The image goes at the end, as a still you can animate or hold." : "The video goes at the end, as a clip of its own."}</span>
        {add.isError && <ErrorNote>{add.error.message}</ErrorNote>}
        <div className="flex gap-2">
          <input autoFocus data-search="add-timeline" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search timelines" aria-label="Search timelines" className="h-9 min-w-0 grow rounded-lg border border-line bg-ground px-3 text-sm" />
          <div className="w-44 shrink-0">
            <Select size="sm" label="Folder" value={folder} onChange={setFolder} options={[{ value: "any", label: "Every folder" }, ...folders.map((x) => ({ value: x.id, label: x.name })), { value: "root", label: "The project's root" }]} />
          </div>
        </div>
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
          {timelines.isSuccess && !items.length && <span className="text-ink-2">{typed.trim() ? "No timeline of that name here." : "No timeline in this folder."}{folder !== "any" && <> <button type="button" onClick={() => setFolder("any")} className="font-semibold text-accent hover:underline">Every folder</button></>}</span>}
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
