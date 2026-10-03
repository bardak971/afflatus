import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, ChevronLeft, Clapperboard, Copy, FileSearch, Film, FolderPlus, Link2, Music, Plus, Scissors, Star, Trash2, Undo2, Wand2, X } from "lucide-react";
import { Trim, type Range } from "./Trim";
import { isShown, secondsInput, type InputSpec, type LoraValue, type SizeValue } from "@afflatus/core";
import { askAboutDisk } from "./Confirm";
import { api, fileUrl, thumbUrl, type Asset, type AssetDetail, type Opened, type RecipeInfo, type Look } from "./api";
import { useAsset, useAssetAction, useFamilies, useFolders, useModelSettings, useRecipes, useSetup, useTimelines } from "./data";
import { formDefaults } from "./form";
import { Kbd, plainKey } from "./Keys";
import { carryOver, followOn, modelGroups, usedLast } from "./picker";
import { clock, fileLabel, notReady, recipeLabel, took, when } from "./format";
import { Select } from "./Select";
import { PngInfo } from "./PngInfo";
import { useBanners, useOpenDraft } from "./store";
import { Button, cx, SectionTitle } from "./ui";
import { ModelLink } from "./ModelLink";

const ROLES: Record<string, string> = { start: "First frame", end: "Last frame", source: "Source image", previous: "Previous clip", next: "Next clip",
  mid: "Keyframe", mask: "Mask", person: "Reference: person", place: "Reference: place", clothing: "Reference: clothing", object: "Reference: object", style: "Reference: style", voice: "Voice sample", sound: "Audio",
};
const mb = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const FORMATS: Record<string, string> = { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP", "video/mp4": "MP4", "video/webm": "WebM", "audio/wav": "WAV", "audio/mpeg": "MP3", "audio/flac": "FLAC", "audio/mp4": "M4A", "audio/ogg": "OGG" };

/** One setting as it was when the item was made, written out for a person. */
function valueOf(spec: InputSpec, value: unknown): ReactNode {
  switch (spec.type) {
    case "model": return <span title={String(value)}>{fileLabel(String(value))}</span>;
    case "choice": return <span title={String(value)}>{fileLabel(String(value))}</span>;
    case "number": return `${value}${spec.unit ?? ""}`;
    case "toggle": return spec.captions ? (value ? spec.captions.on : spec.captions.off) : value ? "On" : "Off";
    case "size": {
      const s = value as SizeValue;
      return `${s.width} × ${s.height}`;
    }
    case "loras": {
      const list = value as LoraValue[];
      if (!list.length) return "None";
      return (
        <span className="flex flex-col gap-0.5">
          {list.map((l) => <span key={l.file} className="flex min-w-0 items-baseline gap-1"><ModelLink folder="loras" file={l.file} className="min-w-0" /> <span className="shrink-0 text-ink-2">at {l.weight.toFixed(2)}</span></span>)}
        </span>
      );
    }
    default: return String(value);
  }
}

/** A block of text that was sent (the description, what to avoid), whole, with a button to copy it. */
function Sent({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-ink-2">{title}</span>
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-2 hover:bg-hover hover:text-ink"
        >
          <Copy size={11} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="rounded-lg bg-raised px-3 py-2.5 leading-normal break-words whitespace-pre-wrap">{text}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-2">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** How it was made: every setting of the form it came from, in the form's order. */
/**
 * The result's graph in ComfyUI's editor: built again from its generation parameters and seed, put where
 * ComfyUI opens it. The tab is opened before the request, or the browser would block it as a pop-up.
 */
function OpenInComfy({ asset }: { asset: Asset }) {
  const setup = useSetup();
  const [opened, setOpened] = useState<Opened | null>(null);
  const open = useMutation({
    mutationFn: async () => {
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
    onSuccess: setOpened,
  });
  const online = setup.data?.comfy.online ?? false;
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <Button size="sm" onClick={() => open.mutate()} disabled={open.isPending || !online} title={online ? "Its graph, built again from these parameters, in ComfyUI's editor. The images and sounds it used are named, not carried over." : "ComfyUI is not running."}>Open in ComfyUI</Button>
      </div>
      {open.isError && <span className="text-xs text-warn-ink">{open.error.message}</span>}
      {opened && !opened.direct && (
        <span className="text-xs text-ink-2">
          Saved in ComfyUI as <span className="font-mono text-ink">{opened.path}</span>: open the Workflows sidebar there (key W) and pick it under "afflatus".{opened.restart ? " Restart ComfyUI once: from then on it opens straight away." : ""}
        </span>
      )}
    </div>
  );
}

function Made({ g, recipe }: { g: NonNullable<AssetDetail["generation"]>; recipe: RecipeInfo | undefined }) {
  const text = (id: string) => (typeof g.inputs[id] === "string" ? (g.inputs[id] as string).trim() : "");
  // the texts are shown whole above; pictures are shown as pictures; a setting that did not apply is left out
  const applied = (recipe?.inputs ?? []).filter((i) => !["prompt", "image", "clip", "references", "audio", "seed"].includes(i.type) && g.inputs[i.id] !== undefined && isShown(i, g.inputs));
  // plain on/off switches read better as one line of what was on than as a column of "Off"
  const isSwitch = (i: InputSpec) => i.type === "toggle" && !i.captions;
  const switches = applied.filter(isSwitch);
  const settings = applied.filter((i) => !isSwitch(i));
  const texts = (recipe?.inputs ?? []).filter((i) => i.type === "prompt" && text(i.id));
  // made with a recipe that is gone: what was sent is still worth showing
  const loose = recipe ? [] : Object.entries(g.inputs).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v));
  return (
    <>
      {texts.map((i) => <Sent key={i.id} title={i.label} text={text(i.id)} />)}
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        {typeof g.resolved.seed === "number" && <Row label="Seed"><span className="font-mono">{g.resolved.seed}</span></Row>}
        {settings.map((i) => <Row key={i.id} label={i.label}>{valueOf(i, g.inputs[i.id])}</Row>)}
        {switches.length > 0 && (
          <Row label="Enabled">
            {switches.some((i) => g.inputs[i.id]) ? switches.filter((i) => g.inputs[i.id]).map((i) => i.label).join(", ") : `None of the ${switches.length}`}
          </Row>
        )}
        {loose.map(([k, v]) => <Row key={k} label={k}>{String(v)}</Row>)}
      </dl>
      {g.resolved.loads && g.resolved.loads.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-ink-2">Model files loaded</span>
          {g.resolved.loads.map((f) => <span key={f} title={f} className="truncate">{fileLabel(f)}</span>)}
        </div>
      )}
    </>
  );
}

/** A row of small pictures that open the item they show. */
function Strip({ items, onOpen }: { items: Array<{ asset: Asset; caption?: string }>; onOpen(asset: Asset): void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(({ asset, caption }) => (
        <button key={`${asset.id}${caption}`} type="button" onClick={() => onOpen(asset)} aria-label={caption ? `Open: ${caption.toLowerCase()}` : "Open"} className="flex w-[76px] flex-col gap-1 text-left">
          {asset.kind === "audio"
            ? <span className="flex h-[76px] w-[76px] items-center justify-center rounded-md border border-line bg-raised text-ink-2">Audio</span>
            : <img src={thumbUrl(asset.id)} alt="" loading="lazy" className="h-[76px] w-[76px] rounded-md border border-line object-cover hover:border-accent" />}
          {caption && <span className="text-[11px] leading-tight text-ink-2">{caption}</span>}
        </button>
      ))}
    </div>
  );
}

/** Where the item is filed, with a way to make the folder on the spot. */
function FolderPicker({ asset }: { asset: Asset }) {
  const folders = useFolders();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const move = useAssetAction((folder: string | null) => api.moveAssets([asset.id], folder));
  const create = useMutation({
    mutationFn: async (folderName: string) => {
      const folder = await api.createFolder(folderName, null);
      await api.moveAssets([asset.id], folder.id);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["assets"] }),
  });
  // a folder inside another shows where it is
  const all = folders.data?.items ?? [];
  const pathOf = (id: string | null): string => {
    const f = all.find((x) => x.id === id);
    return f ? [pathOf(f.parentId), f.name].filter(Boolean).join(" / ") : "";
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-ink-2">Folder{asset.folderId ? "" : " (moving it to a folder keeps it)"}</span>
      <Select
        label="Folder"
        value={asset.folderId ?? ""}
        onChange={(id) => move.mutate(id || null)}
        options={[{ value: "", label: "No folder" }, ...all.map((f) => ({ value: f.id, label: pathOf(f.id), note: `${f.count}` }))]}
        footer={(close) => (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              create.mutate(name.trim());
              setName("");
              close();
            }}
          >
            <FolderPlus size={14} className="ml-1.5 shrink-0 text-ink-2" />
            <input
              aria-label="New folder name"
              placeholder="New folder name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className="h-8 min-w-0 grow rounded-md bg-raised px-2 placeholder:text-ink-3"
            />
            <Button size="sm" tone="quiet" type="submit" disabled={!name.trim()}>Create and move</Button>
          </form>
        )}
      />
      {(move.isError || create.isError) && <span className="text-warn-ink">{(move.error ?? create.error)?.message}</span>}
    </div>
  );
}

/** Put a video or a picture at the end of a timeline, an existing one or a new one, and go there. */
function TimelinePicker({ asset }: { asset: Asset }) {
  const timelines = useTimelines();
  const client = useQueryClient();
  const [, go] = useLocation();
  const add = useMutation({
    mutationFn: async (id: string) => {
      const timeline = id || (await api.createTimeline()).id;
      await api.addClip(timeline, { asset: asset.id });
      return timeline;
    },
    onSuccess: (timeline) => {
      void client.invalidateQueries({ queryKey: ["timelines"] });
      go(`/timelines/${timeline}`);
    },
  });
  return (
    <div className="flex flex-col gap-1.5">
      <Select
        dashed
        icon={<Film size={15} className="shrink-0" />}
        label="Add to timeline"
        placeholder={add.isPending ? "Adding…" : "Add to timeline"}
        value=""
        onChange={(id) => add.mutate(id)}
        options={(timelines.data?.items ?? []).map((t) => ({ value: t.id, label: t.name, note: t.clips ? `${t.clips} clip${t.clips > 1 ? "s" : ""}` : "empty" }))}
        footer={(close) => (
          <button type="button" onClick={() => { add.mutate(""); close(); }} className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover">
            <Plus size={14} className="text-ink-2" /> New timeline
          </button>
        )}
      />
      {add.isError && <span className="text-warn-ink">{add.error.message}</span>}
    </div>
  );
}

/** A picture as a reference image: in which recipe is chosen, none is assumed. Every recipe that takes reference images is listed. */
function ReferencePicker({ asset, onDone }: { asset: Asset; onDone?(): void }) {
  const recipes = useRecipes();
  const client = useQueryClient();
  const [, go] = useLocation();
  const openDraft = useOpenDraft((s) => s.open);
  const on = useFamilies().isOn;
  const ways = (recipes.data?.recipes ?? []).filter((r) => on(r.family) && r.inputs.some((i) => i.type === "references"));
  const start = useMutation({
    mutationFn: (id: string) => {
      const recipe = ways.find((r) => r.id === id)!;
      const slot = recipe.inputs.find((i) => i.type === "references")!;
      const role = slot.type === "references" && slot.roles.includes("person") ? "person" : slot.type === "references" ? slot.roles[0]! : "person";
      return api.createDraft({ recipe: recipe.id, forms: { [recipe.id]: { [slot.id]: [{ asset: asset.id, role }] } } });
    },
    onSuccess: (d) => {
      client.setQueryData(["drafts", d.id], d);
      void client.invalidateQueries({ queryKey: ["drafts"], exact: true });
      openDraft(d.id);
      onDone?.();
      go("/create");
    },
  });
  if (!ways.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <Select
        dashed
        icon={<Star size={15} className="shrink-0" />}
        label="Use as reference image"
        placeholder={start.isPending ? "Opening…" : "Use as reference image"}
        searchHint="Search models"
        value=""
        onChange={(id) => start.mutate(id)}
        options={ways.map((r) => {
          const family = recipes.data?.families.find((f) => f.id === r.family);
          return { value: r.id, label: r.title, detail: r.summary, group: r.id.startsWith("workflow.") ? "Your workflows" : family?.name, search: family?.name };
        })}
      />
      <span className="text-xs text-ink-3">Only models and workflows that take reference images are listed.</span>
      {start.isError && <span className="text-warn-ink">{start.error.message}</span>}
    </div>
  );
}

/** What a tool is handed along with a picture: what the picture was made with (its prompt, model, LoRAs…), where the tool has a place for it. */
function carried(g: AssetDetail["generation"] | null | undefined, from: RecipeInfo | undefined, to: RecipeInfo): Record<string, unknown> {
  if (!g || !from) return {};
  // the picture is the new source; its own source, mask and seed stay behind
  const taken = carryOver(from, to, g.inputs, undefined);
  for (const i of to.inputs) if (i.type === "image" || i.type === "seed") delete taken[i.id];
  return taken;
}

/**
 * What can be done to a picture: every way of making things that takes one picture and gives a picture
 * back (redraw it, paint over a part, enlarge it, fix a face, another shape, no background…), the
 * built-in ones and the imported workflows alike. Picking one opens a new draft with the picture in place.
 */
function ChangePicker({ madeWith, keys, start }: {
  /** What the picture was made with: that model's own tools are listed first, and stand out. */
  madeWith?: RecipeInfo;
  /** The key that opens a tool, by the tool's id. */
  keys: Record<string, string>;
  start: { mutate(id: string): void; isPending: boolean; isError: boolean; error: Error | null };
}) {
  const recipes = useRecipes();
  const setup = useSetup();
  const on = useFamilies().isOn;
  const pictures = (recipes.data?.recipes ?? []).filter((r) => on(r.family) && r.output === "image");
  const all = pictures.filter((r) => r.inputs.some((i) => i.type === "image" && i.role === "source" && !i.optional));
  if (!all.length) return null;
  const online = setup.data?.comfy.online ?? false;
  const mine = madeWith ? modelGroups(pictures, recipes.data?.families ?? []).find((group) => group.recipes.some((r) => r.id === madeWith.id)) : undefined;
  const own = new Set(all.filter((r) => mine?.recipes.includes(r)).map((r) => r.id));
  const ways = [...all.filter((r) => own.has(r.id)), ...all.filter((r) => !own.has(r.id))];
  return (
    <div className="flex flex-col gap-1.5">
      <Select
        dashed
        icon={<Wand2 size={15} className="shrink-0" />}
        label="Image tools"
        placeholder={start.isPending ? "Opening…" : "Image tools"}
        searchHint="Search tools or models"
        value=""
        onChange={(id) => start.mutate(id)}
        options={ways.map((r) => {
          const family = recipes.data?.families.find((f) => f.id === r.family);
          const why = setup.isSuccess ? notReady(setup.data.recipes.find((x) => x.id === r.id), online) : null;
          const note = [keys[r.id] ? `key ${keys[r.id]!.toUpperCase()}` : "", why ? "not ready" : ""].filter(Boolean).join(" · ") || undefined;
          if (own.has(r.id)) return { value: r.id, label: r.title, note, detail: r.summary, group: `${mine!.name} · source model`, search: `${family?.name ?? ""} ${mine!.name}`, marked: true };
          return { value: r.id, label: r.title, note, detail: r.summary, group: family?.name ?? "Your workflows", search: family?.name };
        })}
      />
      {start.isError && <span className="text-warn-ink">{start.error?.message}</span>}
    </div>
  );
}

/** One item, large, with how it was made and what can be done with it. */
/** The operations that have a key, by how their recipes are named. */
/**
 * Who a new draft made from this starts with: the people, the places and the style it was made with.
 * (Not its ticked snippets: those were bits of text for the model it was made with.)
 */
const castOf = (d: AssetDetail | undefined): Look | null => (d?.id && d.look && (d.look.cast.length || d.look.style) ? { cast: d.look.cast, style: d.look.style ?? null, snippets: [] } : null);

const OPS: Record<string, { ends: string[]; label: string }> = {
  u: { ends: [".sharper"], label: "Upscale 2x" },
  f: { ends: [".fix-face"], label: "Face detailer" },
  b: { ends: ["tools.remove-background"], label: "Remove background" },
  i: { ends: [".paint-over"], label: "Inpaint" },
  e: { ends: [".edit", ".redraw"], label: "Edit" },
  r: { ends: [".change-shape"], label: "Outpaint" },
};

export function Viewer({ asset: first, items, onOpen, onClose, inline, onDetails, into }: {
  asset: Asset;
  /** The list it was opened from: the arrow keys go to the item before and after. */
  items?: Asset[];
  onOpen?(asset: Asset): void;
  onClose(): void;
  /** Drawn in place instead of over the screen: the item large, and under it what can be done with it. Its keys work the same. */
  inline?: boolean;
  /** In place: open it over the screen, with everything about it. */
  onDetails?(): void;
  /** What is queued from here belongs to this draft and lands in this folder. */
  into?: { draft?: string; folder?: string };
}) {
  // "made from" and "used to make" lead to other items without leaving the viewer
  const [trail, setTrail] = useState<Asset[]>([]);
  const [info, setInfo] = useState(false);
  // Trim: in and out on a video, and what is done with the range
  const [trim, setTrim] = useState(false);
  const asset = trail.at(-1) ?? first;
  const detail = useAsset(asset.id);
  const recipes = useRecipes();
  const keep = useAssetAction((kept: boolean) => api.keep(asset.id, kept));
  const bin = useAssetAction(() => api.bin(asset.id));
  const restore = useAssetAction(() => api.restore(asset.id));
  const [, go] = useLocation();
  const client = useQueryClient();
  const openDraft = useOpenDraft((s) => s.open);
  /** Over the screen, it steps aside when one of its actions opens a form: the form is what is looked at next. */
  const leave = () => {
    if (!inline) onClose();
  };
  const toForm = (d: Awaited<ReturnType<typeof api.createDraft>>) => {
    client.setQueryData(["drafts", d.id], d);
    void client.invalidateQueries({ queryKey: ["drafts"], exact: true });
    openDraft(d.id);
    leave();
    go("/create");
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
  const player = useRef<HTMLVideoElement>(null);
  const opened = (a: Asset) => {
    void client.invalidateQueries({ queryKey: ["assets"] });
    setTrail((t) => [...t, a]);
  };
  const saveFrame = useMutation({ mutationFn: () => api.frame(asset.id, Math.round((player.current?.currentTime ?? 0) * 1000)), onSuccess: opened });
  const takeSound = useMutation({ mutationFn: () => api.takeSound(asset.id), onSuccess: opened });
  // a frame at a moment picked in Trim: opened here once made
  const frameAt = useMutation({ mutationFn: (atMs: number) => api.frame(asset.id, Math.round(atMs)), onSuccess: opened });
  // the range as new videos: a job of the queue; the library shows them when it is done
  const cutRange = useMutation({
    mutationFn: (v: { range: Range; action: "copy" | "split" | "remove"; crf: number }) => api.range(asset.id, { startMs: Math.round(v.range.startMs), endMs: Math.round(v.range.endMs), action: v.action, crf: v.crf }),
    onSuccess: (_, v) => {
      void client.invalidateQueries({ queryKey: ["queue"] });
      // Trim stays open: the next action may follow on the same range
      say({ id: `cut:${Date.now()}`, tone: "good", title: v.action === "copy" ? "Copying the range to your library" : v.action === "split" ? "Splitting the video" : "Removing the range", text: `In the queue; it needs no GPU. The new video${v.action === "split" ? "s show" : " shows"} in the library when it is done${v.action === "copy" ? "" : "; this one goes to the bin then"}.`, href: "/queue", go: "Open queue" });
    },
  });

  // ---- what the keys do
  const modelSettings = useModelSettings();
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
  const queued = useMutation({
    mutationFn: async (job: { recipe: RecipeInfo; stored: Record<string, unknown>; label: string }) => {
      const status = setup.data?.recipes.find((x) => x.id === job.recipe.id);
      const why = setup.isSuccess ? notReady(status, setup.data.comfy.online) : null;
      if (why) throw new Error(why);
      const input: Record<string, unknown> = { ...formDefaults(job.recipe, status?.options, modelSettings.data?.items ?? [], job.stored).defaults, ...job.stored };
      const has = new Set(job.recipe.inputs.map((i) => i.id));
      for (const id of Object.keys(input)) if (input[id] === undefined || !has.has(id)) delete input[id];
      await api.enqueue(job.recipe.id, input, 1, null, into);
      return job.label;
    },
    onSuccess: (label) => {
      void client.invalidateQueries({ queryKey: ["queue"] });
      say({ id: `key:${Date.now()}`, tone: "good", title: `${label} queued`, href: "/queue", go: "Open queue" });
    },
    onError: (err, job) => say({ id: `key:${Date.now()}`, tone: "bad", title: `${job.label} could not be queued`, text: err.message, href: "/settings", go: "Open settings" }),
  });
  const quick = (key: string) => {
    const tool = toolFor(key);
    if (!tool) return;
    const slot = tool.inputs.find((i) => i.type === "image" && i.role === "source")!;
    queued.mutate({ recipe: tool, stored: { ...carried(g, recipe, tool), [slot.id]: asset.id }, label: OPS[key]!.label });
  };
  /** The item before or after in the list it was opened from. */
  const at = trail.length === 0 && items ? items.findIndex((x) => x.id === first.id) : -1;
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

  const act = useRef<(e: KeyboardEvent) => void>(() => {});
  act.current = (e) => {
    // drawn in place, it leaves the keys to whatever is open over the screen
    if (inline && document.querySelector("[role=dialog][aria-modal=true]")) return;
    if (e.key === "Escape") {
      if (inline) return;
      if (!document.querySelector("[data-keys-help], [role=listbox], [role=menu]") && !info) onClose();
      return;
    }
    if (info || !plainKey(e, { over: "[data-keys-help]" })) return;
    const k = e.key.toLowerCase();
    // a video that has the focus keeps its own arrow keys
    const inPlayer = (e.target as HTMLElement | null)?.tagName === "VIDEO";
    if (e.key === "ArrowLeft" && !inPlayer) move(-1);
    else if (e.key === "ArrowRight" && !inPlayer) move(1);
    else if (a.inBin) return;
    else if (k === "s") keep.mutate(!a.kept);
    else if (e.key === "Delete") void toBin();
    else if (k === "d") download();
    else if (k === "l" && g && recipe) again.mutate(g);
    else if (k === "v" && g && recipe) queued.mutate({ recipe, stored: { ...g.inputs, seed: -1 }, label: "Variation" });
    else if (a.kind === "image" && (k === "u" || k === "f" || k === "b")) quick(k);
    else if (a.kind === "image" && (k === "i" || k === "e" || k === "r") && toolFor(k)) openTool.mutate(toolFor(k)!.id);
    else if (a.kind === "image" && k === "m" && opener) animate.mutate();
    else if (a.kind !== "audio" && k === "p" && !g) setInfo(true);
    else if (a.kind === "video" && k === "c" && carrier) carryOn.mutate();
    else if (a.kind === "video" && k === "g") saveFrame.mutate();
    else if (a.kind === "video" && k === "t" && !a.inBin) setTrim((t) => !t);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => act.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const family = recipes.data?.families.find((f) => f.id === (recipe?.family ?? g?.family));
  const mainText = recipe?.inputs.find((i) => i.type === "prompt")?.id ?? "prompt";
  const prompt = typeof g?.inputs[mainText] === "string" ? (g.inputs[mainText] as string) : "";
  const title = recipe ? recipeLabel(family?.name, recipe.title) : g ? "Generated with a recipe that is no longer here" : a.origin === "uploaded" ? "Uploaded" : a.origin === "generated" ? "Generated" : a.origin === "exported" ? "Timeline export" : a.origin === "frame" ? "Video frame" : a.origin === "imported" && a.kind === "audio" ? "Extracted audio" : "Imported";
  const made = new Date(a.createdAt);
  const sources = detail.data?.id === asset.id ? detail.data.sources : [];
  const usedIn = detail.data?.id === asset.id ? detail.data.usedIn : [];

  if (inline) {
    return (
      <div className="flex min-h-0 min-w-0 grow flex-col gap-2.5">
        <div className="flex min-h-0 grow flex-col items-center justify-center gap-2">
          {a.kind === "image" && (
            <button type="button" onClick={onDetails} title="Details: generation parameters, lineage and every action" className="flex h-full max-w-full items-center justify-center">
              <img key={a.id} src={fileUrl(a.id)} alt={prompt || "Image"} className="max-h-full max-w-full rounded-lg object-contain" />
            </button>
          )}
          {a.kind === "video" && (
            <div className="flex min-h-0 w-full flex-1 items-center justify-center">
              <video key={a.id} ref={player} src={fileUrl(a.id)} poster={thumbUrl(a.id)} controls={!trim} className="max-h-full max-w-full rounded-lg" onClick={(e) => { if (trim) { const v = e.currentTarget; if (v.paused) void v.play(); else v.pause(); } }} />
            </div>
          )}
          {a.kind === "audio" && <audio key={a.id} src={fileUrl(a.id)} controls />}
          {a.kind === "video" && trim && (
            <Trim
              key={a.id}
              asset={a}
              player={player}
              busy={cutRange.isPending || frameAt.isPending || between.isPending || extendHere.isPending}
              onCopy={(range, crf) => cutRange.mutate({ range, action: "copy", crf })}
              onSplit={(range, crf) => cutRange.mutate({ range, action: "split", crf })}
              onRemove={(range, crf) => cutRange.mutate({ range, action: "remove", crf })}
              onFrame={(atMs) => frameAt.mutate(atMs)}
              onBetween={opener ? (range) => between.mutate(range) : undefined}
              onExtendHere={carrier || opener ? (atMs) => extendHere.mutate(atMs) : undefined}
              onClose={() => setTrim(false)}
            />
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-1.5 pb-3">
          <Button size="sm" onClick={() => keep.mutate(!a.kept)} className={cx(a.kept && "border-accent text-accent")} title={a.kept ? "Kept" : "Not kept: it goes to the bin after a day"}>
            <Star size={13} fill={a.kept ? "currentColor" : "none"} /> {a.kept ? "Kept" : "Keep"} <Kbd>S</Kbd>
          </Button>
          {g && recipe && (
            <Button size="sm" disabled={queued.isPending} title="Same parameters, new seed: queued at once." onClick={() => queued.mutate({ recipe, stored: { ...g.inputs, seed: -1 }, label: "Variation" })}>Variation <Kbd>V</Kbd></Button>
          )}
          {a.kind === "image" && (["u", "f", "b"] as const).filter((k) => toolFor(k)).map((k) => (
            <Button key={k} size="sm" disabled={queued.isPending} title={`${OPS[k]!.label}: queued at once with the image's generation parameters.`} onClick={() => quick(k)}>{OPS[k]!.label} <Kbd>{k.toUpperCase()}</Kbd></Button>
          ))}
          {a.kind === "image" && (["i", "e", "r"] as const).filter((k) => toolFor(k)).map((k) => (
            <Button key={k} size="sm" disabled={openTool.isPending} title={`${OPS[k]!.label}: a new draft in the form, with this image as the source.`} onClick={() => openTool.mutate(toolFor(k)!.id)}>{OPS[k]!.label}… <Kbd>{k.toUpperCase()}</Kbd></Button>
          ))}
          {a.kind === "image" && opener && <Button size="sm" disabled={animate.isPending} title={`Image to video (i2v): a new video with this image as the first frame, on ${openerName} (the video model used last).`} onClick={() => animate.mutate()}><Clapperboard size={13} /> i2v <Kbd>M</Kbd></Button>}
          {a.kind === "video" && carrier && <Button size="sm" disabled={carryOn.isPending} title={fromLastFrame ? "Extend: a new clip whose first frame is the last frame of this one, same model and parameters." : "Extend: a new clip that carries on from the end of this one (previous clip)."} onClick={() => carryOn.mutate()}><Link2 size={13} /> Extend <Kbd>C</Kbd></Button>}
          {a.kind === "video" && <Button size="sm" disabled={saveFrame.isPending} title="Pause the video on the frame you want, then save it as an image." onClick={() => saveFrame.mutate()}><Camera size={13} /> Save frame <Kbd>G</Kbd></Button>}
          {a.kind === "video" && !a.inBin && <Button size="sm" className={cx(trim && "border-accent text-accent")} title="Trim: pick an in and an out, then copy, split or remove the range, save its frames, or generate between them." onClick={() => setTrim(!trim)}><Scissors size={13} /> Trim <Kbd>T</Kbd></Button>}
          {onDetails && <Button size="sm" onClick={onDetails} title="Generation parameters, folder, lineage and every action">Details</Button>}
          <Button size="sm" onClick={() => void toBin()} title="Move to the bin and go to the next one"><Trash2 size={13} /> Bin <Kbd>Del</Kbd></Button>
        </div>
      </div>
    );
  }

  return (
    <div data-stage role="dialog" aria-modal="true" aria-label="Item" className="fixed inset-0 z-40 flex bg-ground/95">
      <div className="flex min-w-0 grow flex-col items-center justify-center gap-3 p-6" onClick={onClose}>
        {a.kind === "image" && <img key={a.id} src={fileUrl(a.id)} alt={prompt || "Image"} className="max-h-full max-w-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />}
        {a.kind === "video" && (
          <div className="flex min-h-0 w-full flex-1 items-center justify-center" onClick={onClose}>
            <video key={a.id} ref={player} src={fileUrl(a.id)} poster={thumbUrl(a.id)} controls={!trim} className="max-h-full max-w-full rounded-lg" onClick={(e) => { e.stopPropagation(); if (trim) { const v = e.currentTarget; if (v.paused) void v.play(); else v.pause(); } }} />
          </div>
        )}
        {a.kind === "audio" && <audio key={a.id} src={fileUrl(a.id)} controls onClick={(e) => e.stopPropagation()} />}
        {a.kind === "video" && trim && (
          <Trim
            key={a.id}
            asset={a}
            player={player}
            busy={cutRange.isPending || frameAt.isPending || between.isPending || extendHere.isPending}
            onCopy={(range, crf) => cutRange.mutate({ range, action: "copy", crf })}
            onSplit={(range, crf) => cutRange.mutate({ range, action: "split", crf })}
            onRemove={(range, crf) => cutRange.mutate({ range, action: "remove", crf })}
            onFrame={(atMs) => frameAt.mutate(atMs)}
            onBetween={opener ? (range) => between.mutate(range) : undefined}
            onExtendHere={carrier || opener ? (atMs) => extendHere.mutate(atMs) : undefined}
            onClose={() => setTrim(false)}
          />
        )}
      </div>

      <aside className="flex w-[400px] shrink-0 flex-col border-l border-line bg-panel">
        <div className="flex min-h-14 shrink-0 items-center gap-1 border-b border-line p-2">
          {trail.length > 0 && (
            <button type="button" aria-label="Back to the previous item" onClick={() => setTrail(trail.slice(0, -1))} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"><ChevronLeft size={16} /></button>
          )}
          <span className={cx("min-w-0 grow font-semibold", trail.length === 0 && "pl-2")}>{title}</span>
          {at >= 0 && items!.length > 1 && <span className="shrink-0 text-xs text-ink-2" title="Arrow keys: previous and next item">{at + 1} of {items!.length} <Kbd>←</Kbd> <Kbd>→</Kbd></span>}
          <button type="button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => window.dispatchEvent(new Event("afflatus:keys"))} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover">?</button>
          <button type="button" aria-label="Close" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"><X size={16} /></button>
        </div>
        <div className="flex min-h-0 grow flex-col gap-4 overflow-y-auto p-4">
          {a.inBin ? (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-warn-wash px-3 py-2 text-warn-ink">
              <span>In the bin.</span>
              <Button size="sm" tone="danger" onClick={() => restore.mutate(undefined)}><Undo2 size={14} /> Restore</Button>
            </div>
          ) : (
            !a.kept && (
              <div className="flex items-center justify-between gap-3 rounded-lg bg-warn-wash px-3 py-2 text-warn-ink">
                <span>Not kept: it goes to the bin after a day.</span>
                <Button size="sm" tone="danger" onClick={() => keep.mutate(true)}>Keep</Button>
              </div>
            )
          )}

          <div className="flex flex-col gap-2">
            <SectionTitle>{a.kind === "image" ? "Image" : a.kind === "video" ? "Video" : "Audio"}</SectionTitle>
            <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
              {a.name && <Row label="Name">{a.name}</Row>}
              {a.width && a.height ? <Row label="Resolution">{a.width} × {a.height}</Row> : null}
              {a.kind === "video" && a.durationMs ? <Row label="Duration">{(a.durationMs / 1000).toFixed(1)} s{a.fps ? `, ${Math.round(a.fps)} fps` : ""}</Row> : null}
              {a.kind === "video" && a.durationMs ? <Row label="Audio">{a.hasSound ? "Yes" : "No"}</Row> : null}
              {g?.resolved.overlap?.headMs ? <Row label="Head overlap">The first {(g.resolved.overlap.headMs / 1000).toFixed(1)} s repeat the end of the previous clip. A timeline skips them.</Row> : null}
              {g?.resolved.overlap?.tailMs ? <Row label="Tail overlap">The last {(g.resolved.overlap.tailMs / 1000).toFixed(1)} s repeat the start of the next clip. A timeline skips them.</Row> : null}
              <Row label="File">{FORMATS[a.mime] ?? a.mime}, {mb(a.bytes)}</Row>
              {a.path && <Row label={a.inBin ? "Was at" : "Path"}><span className="font-mono text-xs break-all">{a.path}</span></Row>}
              <Row label="Created">{made.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} at {made.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} ({when(a.createdAt)})</Row>
              {g && <Row label="Render time">{took(g.tookMs)}</Row>}
            </dl>
          </div>

          {g && (
            <div className="flex flex-col gap-2.5">
              <SectionTitle>Generation parameters</SectionTitle>
              <Made g={g} recipe={recipe} />
              {recipe && <OpenInComfy asset={a} />}
            </div>
          )}

          {(sources.length > 0 || detail.data?.source) && (
            <div className="flex flex-col gap-2">
              <SectionTitle>Source</SectionTitle>
              <Strip
                items={[
                  ...(detail.data?.source ? [{ asset: detail.data.source.asset, caption: detail.data.source.range ? `${clock(detail.data.source.range.startMs)}–${clock(detail.data.source.range.endMs)} of it` : a.kind === "image" ? "Frame of it" : "Cut from it" }] : []),
                  ...sources.map((s) => ({ asset: s.asset, caption: ROLES[s.role] ?? s.role })),
                ]}
                onOpen={(next) => setTrail([...trail, next])}
              />
            </div>
          )}
          {usedIn.length > 0 && (
            <div className="flex flex-col gap-2">
              <SectionTitle>Used in</SectionTitle>
              <Strip items={usedIn.map((u) => ({ asset: u }))} onOpen={(next) => setTrail([...trail, next])} />
            </div>
          )}

          {!a.inBin && <FolderPicker asset={a} />}
          {!a.inBin && a.kind !== "audio" && <TimelinePicker asset={a} />}
          {!a.inBin && a.kind === "image" && (
            <ChangePicker madeWith={recipe} keys={Object.fromEntries((["i", "e", "r"] as const).flatMap((k) => (toolFor(k) ? [[toolFor(k)!.id, k]] : [])))} start={openTool} />
          )}
          {!a.inBin && a.kind === "image" && (
            <div className="flex flex-wrap gap-1.5">
              {(["u", "f", "b"] as const).filter((k) => toolFor(k)).map((k) => (
                <Button key={k} size="sm" disabled={queued.isPending} title={`${OPS[k]!.label}: queued at once with the image's generation parameters.`} onClick={() => quick(k)}>
                  {OPS[k]!.label} <Kbd>{k.toUpperCase()}</Kbd>
                </Button>
              ))}
            </div>
          )}
          {!a.inBin && a.kind === "image" && <ReferencePicker asset={a} onDone={leave} />}

          <div className="flex flex-col gap-2">
            {g && recipe && (
              <div className="flex gap-2">
                <Button className="grow" onClick={() => again.mutate(g)} disabled={again.isPending} title="Open the form with the same generation parameters, as a new draft.">Reuse parameters <Kbd>L</Kbd></Button>
                <Button onClick={() => queued.mutate({ recipe, stored: { ...g.inputs, seed: -1 }, label: "Variation" })} disabled={queued.isPending} title="Same parameters, new seed: queued at once.">Variation <Kbd>V</Kbd></Button>
              </div>
            )}
            {a.kind === "image" && !a.inBin && opener && (
              <Button onClick={() => animate.mutate()} disabled={animate.isPending} title={`A new video with this image as the first frame, on ${openerName} (the video model used last).`}>
                <Clapperboard size={15} /> Image to video (i2v) <Kbd>M</Kbd>
              </Button>
            )}
            {a.kind === "audio" && !a.inBin && follower && (
              <Button onClick={() => follow.mutate()} disabled={follow.isPending} title="A new video in which the person speaks with this voice sample.">
                <Music size={15} /> Use as voice sample
              </Button>
            )}
            {a.kind !== "audio" && !a.inBin && !g && (
              <Button onClick={() => setInfo(true)} title="The generation parameters embedded in the file: prompt, checkpoint, LoRAs and sampling settings, whether your ComfyUI has them, and sending them to a form.">
                <FileSearch size={15} /> PNG info <Kbd>P</Kbd>
              </Button>
            )}
            {a.kind === "video" && !a.inBin && (
              <Button onClick={() => saveFrame.mutate()} disabled={saveFrame.isPending} title="Pause the video on the frame you want, then save it as an image in your library.">
                <Camera size={15} /> {saveFrame.isPending ? "Saving…" : "Save frame"} <Kbd>G</Kbd>
              </Button>
            )}
            {a.kind === "video" && !a.inBin && (
              <Button onClick={() => setTrim(!trim)} className={cx(trim && "border-accent text-accent")} title="Trim: pick an in and an out, then copy, split or remove the range, save its frames, or generate between them.">
                <Scissors size={15} /> Trim <Kbd>T</Kbd>
              </Button>
            )}
            {a.kind === "video" && !a.inBin && a.hasSound && (
              <Button onClick={() => takeSound.mutate()} disabled={takeSound.isPending} title="Its audio track as an audio file of its own in your library: for another clip, or as music.">
                <Music size={15} /> {takeSound.isPending ? "Extracting…" : "Extract audio"}
              </Button>
            )}
            {(saveFrame.isError || takeSound.isError || animate.isError || carryOn.isError || cutRange.isError || between.isError || extendHere.isError || frameAt.isError) && <span className="text-warn-ink">{(saveFrame.error ?? takeSound.error ?? animate.error ?? carryOn.error ?? cutRange.error ?? between.error ?? extendHere.error ?? frameAt.error)?.message}</span>}
            {a.kind === "video" && !a.inBin && carrier && (
              <Button onClick={() => carryOn.mutate()} disabled={carryOn.isPending} title={fromLastFrame ? "A new clip whose first frame is the last frame of this one, same model and parameters. The frame is saved as an image in your library." : "A new clip that carries on from the end of this one (previous clip). You can pick the frame it starts from."}>
                <Link2 size={15} /> Extend <Kbd>C</Kbd>
              </Button>
            )}
            {!a.inBin && (
              <Button onClick={() => keep.mutate(!a.kept)} className={cx(a.kept && "border-accent text-accent")}>
                <Star size={15} fill={a.kept ? "currentColor" : "none"} /> {a.kept ? "Kept" : "Keep"} <Kbd>S</Kbd>
              </Button>
            )}
            {!a.inBin && (
              <div className="flex gap-2">
                <Button className="grow" onClick={() => void toBin()}>
                  <Trash2 size={15} /> Move to the bin <Kbd>Del</Kbd>
                </Button>
                <Button onClick={download} title="Download the file">Download <Kbd>D</Kbd></Button>
              </div>
            )}
          </div>
        </div>
      </aside>
      {info && <PngInfo name={asset.name || "Untitled"} read={(recipe) => api.assetEmbedded(asset.id, recipe)} onClose={() => setInfo(false)} onSent={leave} />}
    </div>
  );
}
