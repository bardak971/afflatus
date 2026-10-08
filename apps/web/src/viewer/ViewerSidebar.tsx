import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Copy, Film, FolderPlus, Plus, Star, Trash2, Undo2, Wand2 } from "lucide-react";
import { isShown, RANDOM_SEED, type InputSpec, type LoraValue, type ReferenceValue, type SizeValue } from "@afflatus/core";
import { useAddToTimeline, useLast, useOpenInComfy, useStartTimeline } from "../actions";
import { api, thumbUrl, type Asset, type AssetDetail, type Opened, type RecipeInfo } from "../api";
import { useAssetAction, useEntities, useFamilies, useFolders, useRecipes, useSetup, useTimelines, type useAsset } from "../data";
import { useOpenNewDraft } from "../draft";
import { Kbd } from "../Keys";
import { modelGroups } from "../picker";
import { clock, fileLabel, notReady, recipeLabel, took, when } from "../format";
import { Select } from "../Select";
import { Button, cx, fieldClass, SectionTitle } from "../ui";
import { FieldRow } from "../fields";
import { ModelLink } from "../ModelLink";
import { FORMATS, mb, OPS } from "./shared";
import { ViewerHeader } from "./ViewerHeader";
import type { ViewerActions } from "./useViewerActions";
import { copyText } from "../secureContext";

// what a source was to the render: the quiet line under its name
const ROLES: Record<string, string> = { start: "first frame", end: "last frame", source: "source image", previous: "previous clip", next: "next clip",
  mid: "keyframe", mask: "mask", person: "person", place: "place", clothing: "clothing", object: "object", style: "style", voice: "voice sample", sound: "audio",
};

/** Whose picture it is in the prompt kit (a person, one of their outfits, a place), by the picture's id. */
function useKitNames(): Map<string, { name: string; what: string }> {
  const entities = useEntities();
  const names = new Map<string, { name: string; what: string }>();
  for (const e of entities.data?.items ?? []) {
    if (e.kind === "person") {
      for (const id of e.def.pictures) names.set(id, { name: e.name, what: "person" });
      for (const o of e.def.outfits) if (o.picture) names.set(o.picture, { name: e.name, what: `outfit · ${o.name}` });
    }
    if (e.kind === "place") for (const id of e.def.pictures) names.set(id, { name: e.name, what: "place" });
  }
  return names;
}

/** One setting as it was when the item was made, written out for a person. */
function valueOf(spec: InputSpec, value: unknown): ReactNode {
  switch (spec.type) {
    case "model": return <span data-tip={String(value)}>{fileLabel(String(value))}</span>;
    case "choice": return <span data-tip={String(value)}>{fileLabel(String(value))}</span>;
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

/**
 * A block of text that was sent (the description, what to avoid), whole, with a button to copy it. Folded:
 * one line of it and a chevron, for the texts few people read again (what to avoid).
 */
function Sent({ title, text, folded }: { title: string; text: string; folded?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); void copyText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {}); }}
      className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-2 hover:bg-hover hover:text-ink"
    >
      <Copy size={11} /> {copied ? "Copied" : "Copy"}
    </button>
  );
  if (folded) {
    // the Copy button sits over the summary's right end, beside it in the tree: a summary holds no button
    return (
      <div className="relative">
        <details className="group rounded-lg bg-raised">
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 pr-16 text-xs text-ink-2 hover:text-ink">
            <ChevronDown size={13} className="shrink-0 transition-transform group-open:rotate-180" />
            <span className="shrink-0 font-semibold">{title}</span>
            <span className="min-w-0 grow truncate group-open:hidden">{text.replace(/\s+/g, " ")}</span>
          </summary>
          <div className="border-t border-line px-3 py-2.5 leading-normal break-words whitespace-pre-wrap">{text}</div>
        </details>
        <span className="absolute top-1.5 right-2">{copy}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <SectionTitle>{title}</SectionTitle>
        {copy}
      </div>
      <div className="max-h-[220px] overflow-y-auto rounded-xl border border-line bg-raised p-3 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap">{text}</div>
    </div>
  );
}

/** One thing to do with the item: a word, its key. Pressed: it is on (Kept, Trim). */
function Act({ label, k, pressed, onClick, disabled, title, wide }: { label: string; k?: string; pressed?: boolean; onClick(): void; disabled?: boolean; title?: string; wide?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-tip={title}
      aria-pressed={pressed}
      className={cx(
        "flex h-[38px] min-w-0 items-center gap-2 rounded-[10px] border px-3 text-left text-[13px] font-semibold hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50",
        pressed ? "border-accent bg-accent-wash text-accent" : "border-line bg-raised text-ink hover:border-line-strong",
        wide && "col-span-2",
      )}
    >
      <span className="min-w-0 grow truncate">{label}</span>
      {k && <Kbd>{k}</Kbd>}
    </button>
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

/**
 * The result's graph in ComfyUI's editor: built again from its generation parameters and seed, put where
 * ComfyUI opens it. The tab is opened before the request, or the browser would block it as a pop-up.
 */
function OpenInComfy({ asset }: { asset: Asset }) {
  const setup = useSetup();
  const [opened, setOpened] = useState<Opened | null>(null);
  const open = useOpenInComfy(() => api.openRender(asset.id), { onSuccess: setOpened });
  const online = setup.data?.comfy.online ?? false;
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <Button size="sm" onClick={() => open.mutate()} disabled={open.isPending || !online} data-tip={online ? "Its graph, built again from these parameters, in ComfyUI's editor. The images and sounds it used are named, not carried over." : "ComfyUI is not running."}>Open in ComfyUI</Button>
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

/** One setting in the parameters grid: its name dim, its value in the mono face. Wide: it takes the two columns. */
function Cell({ label, children, title, wide }: { label: string; children: ReactNode; title?: string; wide?: boolean }) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-0.5", wide && "col-span-2")}>
      <span className="text-ink-3">{label}</span>
      <span data-tip={title} className={cx("min-w-0 font-mono text-ink", !wide && "truncate")}>{children}</span>
    </div>
  );
}

/** The sampling settings shown up front even where the form keeps them under Advanced: what is asked of a render first. */
const UP_FRONT = ["steps", "cfg", "sampler", "scheduler"];

/** How it was made: every setting of the form it came from, in the form's order. */
function Made({ g, recipe, asset }: { g: NonNullable<AssetDetail["generation"]>; recipe: RecipeInfo | undefined; asset: Asset }) {
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
  // the main text whole; what to avoid and the other texts folded to a line
  const main = texts.find((i) => !("optional" in i && i.optional) && i.id !== "negative") ?? texts[0];
  // what the form shows up front is what matters, and the sampling; what sits under Advanced is folded here too
  const key = settings.filter((i) => !i.advanced || UP_FRONT.includes(i.id));
  const rest = settings.filter((i) => !key.includes(i));
  const more = rest.length + (switches.length ? 1 : 0) + loose.length + (g.resolved.loads?.length ? 1 : 0);
  // sampler and scheduler side by side, as one
  const sampler = key.find((i) => i.id === "sampler");
  const scheduler = sampler && key.find((i) => i.id === "scheduler");
  const plain = (i: InputSpec) => fileLabel(String(g.inputs[i.id]));
  // the reference pictures given: what each was for (the pictures themselves are under Source)
  const refs = (recipe?.inputs ?? []).flatMap((i) => (i.type === "references" && Array.isArray(g.inputs[i.id]) ? (g.inputs[i.id] as ReferenceValue[]) : []));
  const cells = key.filter((i) => i !== scheduler).map((i) => {
    if (i === sampler && scheduler) return <Cell key={i.id} label="Sampler · scheduler" title={`${plain(i)} · ${plain(scheduler)}`}>{plain(i)} · {plain(scheduler)}</Cell>;
    const many = i.type === "loras" && (g.inputs[i.id] as LoraValue[]).length > 0;
    const value = valueOf(i, g.inputs[i.id]);
    return <Cell key={i.id} label={i.label} wide={many} title={typeof value === "string" ? value : undefined}>{value}</Cell>;
  });
  const rows = (list: InputSpec[]) => list.map((i) => <Row key={i.id} label={i.label}>{valueOf(i, g.inputs[i.id])}</Row>);
  return (
    <>
      {texts.map((i) => <Sent key={i.id} title={i.label} text={text(i.id)} folded={i !== main} />)}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
        {typeof g.resolved.seed === "number" && <Cell label="Seed">{g.resolved.seed}</Cell>}
        {cells}
        {refs.length > 0 && <Cell label={refs.length > 1 ? "References" : "Reference"}>{[...new Set(refs.map((r) => r.role))].map((role) => { const n = refs.filter((r) => r.role === role).length; return n > 1 ? `${role} ×${n}` : role; }).join(" · ")}</Cell>}
      </div>
      {(more > 0 || recipe) && (
        <details className="group rounded-lg border border-line">
          <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs font-semibold text-ink-2 hover:text-ink">
            <ChevronDown size={13} className="transition-transform group-open:rotate-180" /> {more > 0 ? `All parameters · ${more} more` : "In ComfyUI"}
          </summary>
          <div className="flex flex-col gap-3 border-t border-line p-3">
            {(rest.length > 0 || switches.length > 0 || loose.length > 0) && (
              <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                {rows(rest)}
                {switches.length > 0 && (
                  <Row label="Enabled">
                    {switches.some((i) => g.inputs[i.id]) ? switches.filter((i) => g.inputs[i.id]).map((i) => i.label).join(", ") : `None of the ${switches.length}`}
                  </Row>
                )}
                {loose.map(([k, v]) => <Row key={k} label={k}>{String(v)}</Row>)}
              </dl>
            )}
            {g.resolved.loads && g.resolved.loads.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-ink-2">Model files loaded</span>
                {g.resolved.loads.map((f) => <span key={f} data-tip={f} className="truncate">{fileLabel(f)}</span>)}
              </div>
            )}
            {recipe && <OpenInComfy asset={asset} />}
          </div>
        </details>
      )}
    </>
  );
}

/**
 * A row of small pictures that open the item they show: under each its name (whose it is, in accent, when it is
 * a prompt-kit picture) and what it was to the render. No name: what it was, alone.
 */
function Strip({ items, onOpen }: { items: Array<{ asset: Asset; name?: string; kit?: boolean; caption?: string }>; onOpen(asset: Asset): void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(({ asset, name, kit, caption }) => (
        <button key={`${asset.id}${caption}`} type="button" onClick={() => onOpen(asset)} aria-label={`Open: ${[name, caption].filter(Boolean).join(", ") || "item"}`} data-tip={name && caption ? `${name} · ${caption}` : undefined} className="flex w-[76px] flex-col gap-0.5 text-left">
          {asset.kind === "audio"
            ? <span className="flex h-[76px] w-[76px] items-center justify-center rounded-lg border border-line bg-raised text-ink-2">Audio</span>
            : <img src={thumbUrl(asset.id)} alt="" loading="lazy" className={cx("h-[76px] w-[76px] rounded-lg border object-cover hover:border-accent", kit ? "border-accent/70" : "border-line")} />}
          {name && <span className={cx("mt-0.5 truncate text-xs font-semibold", kit && "text-accent")}>{name}</span>}
          {caption && <span className={cx("truncate text-[11px] leading-tight", name ? "text-ink-3" : "mt-0.5 text-ink-2")}>{caption}</span>}
        </button>
      ))}
    </div>
  );
}

/** Where the item is filed, with a way to make the folder on the spot. */
function FolderPicker({ asset }: { asset: Asset }) {
  const folders = useFolders();
  const [name, setName] = useState("");
  const move = useAssetAction((folder: string | null) => api.moveAssets([asset.id], folder));
  const create = useMutation({
    mutationFn: async (folderName: string) => {
      const folder = await api.createFolder(folderName, null);
      await api.moveAssets([asset.id], folder.id);
    },
    // the library refreshes on the server's own word (its `library` event)
  });
  // a folder inside another shows where it is
  const all = folders.data?.items ?? [];
  const pathOf = (id: string | null): string => {
    const f = all.find((x) => x.id === id);
    return f ? [pathOf(f.parentId), f.name].filter(Boolean).join(" / ") : "";
  };
  return (
    <FieldRow label="Folder" note="Where it is filed. Moving it out of the Inbox into a folder keeps it: it no longer goes to the bin after a day.">
      <Select
        label="Folder"
        value={asset.folderId ?? ""}
        onChange={(id) => move.mutate(id || null)}
        options={[{ value: "", label: "Inbox", note: "no folder" }, ...all.map((f) => ({ value: f.id, label: pathOf(f.id), note: `${f.count}` }))]}
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
              className={cx(fieldClass, "h-8 min-w-0 grow px-2")}
            />
            <Button size="sm" tone="quiet" type="submit" disabled={!name.trim()}>Create and move</Button>
          </form>
        )}
      />
      {(move.isError || create.isError) && <span className="text-warn-ink">{(move.error ?? create.error)?.message}</span>}
    </FieldRow>
  );
}

/** Put a video or a picture at the end of a timeline, an existing one or a new one, and go there. */
function TimelinePicker({ asset }: { asset: Asset }) {
  const timelines = useTimelines();
  const [, go] = useLocation();
  const add = useAddToTimeline(asset, { onSuccess: (target) => go(`/timelines/${target.id}`) });
  const last = useLast();
  const start = useStartTimeline({ onSuccess: (target) => go(`/timelines/${target.id}`) });
  return (
    <FieldRow label="Timeline">
      <div className="flex min-w-0 gap-1.5">
        {last && (
          <Button size="sm" className="min-w-0 grow justify-start" disabled={add.isPending} data-tip={`At the end of ${last.name}, the timeline you last added to`} onClick={() => add.mutate(last.id)}>
            <span className="truncate"><span className="font-normal text-ink-2">Add to</span> {last.name}</span> <Kbd>A</Kbd>
          </Button>
        )}
        {/* the other timelines, and a new one: behind the chevron when there is a last one, the whole field otherwise */}
        <Select
          icon={last ? undefined : <Film size={15} className="shrink-0" />}
          label="Add to timeline"
          placeholder={add.isPending ? "Adding…" : last ? "" : "Add to…"}
          className={last ? "w-10 shrink-0 justify-center px-0" : "min-w-0 grow"}
          value=""
        onChange={(id) => add.mutate(id)}
        options={(timelines.data?.items ?? []).map((t) => ({ value: t.id, label: t.name, note: t.clips ? `${t.clips} clip${t.clips > 1 ? "s" : ""}` : "empty" }))}
        footer={(close) => (
          <button type="button" onClick={() => { add.mutate(null); close(); }} className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover">
            <Plus size={14} className="text-ink-2" /> New timeline
          </button>
        )}
        />
        <Button size="sm" className="shrink-0" disabled={start.isPending} data-tip={asset.kind === "image" ? "Start a timeline from it: clip 1 opens on this picture, its form open" : "Start a timeline from it: this video is clip 1"} onClick={() => start.mutate(asset)}>New <Kbd>N</Kbd></Button>
      </div>
      {add.isError && <span className="text-warn-ink">{add.error.message}</span>}
    </FieldRow>
  );
}

/** A picture as a reference image: in which recipe is chosen, none is assumed. Every recipe that takes reference images is listed. */
function ReferencePicker({ asset, onDone }: { asset: Asset; onDone?(): void }) {
  const recipes = useRecipes();
  const openNew = useOpenNewDraft();
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
      onDone?.();
      openNew(d);
    },
  });
  if (!ways.length) return null;
  return (
    <FieldRow label="Reference" note="Use it as a reference image: a new draft of the model picked, this picture in its references. Only the models and workflows that take reference images are listed.">
      <Select
        icon={<Star size={15} className="shrink-0 text-ink-2" />}
        label="Use as reference image"
        placeholder={start.isPending ? "Opening…" : "Pick a model…"}
        searchHint="Search models"
        value=""
        onChange={(id) => start.mutate(id)}
        options={ways.map((r) => {
          const family = recipes.data?.families.find((f) => f.id === r.family);
          return { value: r.id, label: r.title, detail: r.summary, group: r.id.startsWith("workflow.") ? "Your workflows" : family?.name, search: family?.name };
        })}
      />
      {start.isError && <span className="text-warn-ink">{start.error.message}</span>}
    </FieldRow>
  );
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

/**
 * Everything about the item, beside it: what it is, what can be done with it, how it was made, where it
 * came from and what it was used in, the tools for a picture, where to put it, and the file's details.
 */
export function ViewerSidebar({ acts, asset, detail, trail, onTrail: setTrail, items, trim, onTrim: setTrim, onInfo: setInfo, naming, onNaming, onClose, comparing, onCompare }: {
  /** Compare: the one on screen is pinned and the arrow keys move the other; present when there is a list to move through. */
  comparing?: boolean;
  onCompare?(): void;
  acts: ViewerActions;
  /** The item as it was listed (see ViewerHeader). */
  asset: Asset;
  detail: ReturnType<typeof useAsset>;
  /** The items followed from the first one: "made from" and "used to make"; Back steps out of it. */
  trail: Asset[];
  onTrail(trail: Asset[]): void;
  /** The list it was opened from, for "n of m". */
  items?: Asset[];
  trim: boolean;
  onTrim(trim: boolean): void;
  /** The embedded generation parameters, read from the file. */
  onInfo(open: true): void;
  /** The name is being edited in place (F2, or a click on it). */
  naming: boolean;
  onNaming(naming: boolean): void;
  onClose(): void;
}) {
  const { a, g, recipe, recipes, keep, restore, leave, again, carrier, fromLastFrame, carryOn, opener, openerName, animate, follower, follow, saveFrame, takeSound, frameAt, cutRange, mirror, between, extendHere, toolFor, openTool, queued, quick, toBin, download } = acts;
  const family = recipes.data?.families.find((f) => f.id === (recipe?.family ?? g?.family));
  const title = recipe ? recipeLabel(family?.name, recipe.title) : g ? "Generated with a recipe that is no longer here" : a.origin === "uploaded" ? "Uploaded" : a.origin === "generated" ? "Generated" : a.origin === "exported" ? "Timeline export" : a.origin === "frame" ? "Video frame" : a.origin === "edited" ? "Edited copy" : a.origin === "imported" && a.kind === "audio" ? "Extracted audio" : "Imported";
  const made = new Date(a.createdAt);
  const sources = detail.data?.id === a.id ? detail.data.sources : [];
  const usedIn = detail.data?.id === a.id ? detail.data.usedIn : [];
  const kitNames = useKitNames();
  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l border-line bg-panel">
      <ViewerHeader acts={acts} asset={asset} detail={detail} title={title} trail={trail} onTrail={setTrail} items={items} naming={naming} onNaming={onNaming} onClose={onClose} />
      <div className="flex min-h-0 grow flex-col gap-4 overflow-y-auto px-5 py-3.5">
        {a.inBin ? (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-warn-wash px-3 py-2.5 text-warn-ink">
            <span>In the bin.</span>
            <Button size="sm" tone="danger" onClick={() => restore.mutate(undefined)}><Undo2 size={14} /> Restore</Button>
          </div>
        ) : (
          !a.kept && (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-warn-wash px-3 py-2.5 text-warn-ink">
              <span>Not kept: it goes to the bin after a day.</span>
              <Button size="sm" tone="danger" onClick={() => keep.mutate(true)}>Keep</Button>
            </div>
          )
        )}

        {/* what to do with it: two columns, the item's own kind of things first */}
        <div className="grid grid-cols-2 gap-2">
          {g && recipe && <Act label="Reuse parameters" k="L" onClick={() => again.mutate(g)} disabled={again.isPending} title="Open the form with the same generation parameters, as a new draft." />}
          {g && recipe && <Act label="Variation" k="V" onClick={() => queued.mutate({ recipe, stored: { ...g.inputs, seed: RANDOM_SEED }, label: "Variation" })} disabled={queued.isPending} title="Same parameters, new seed: queued at once." />}
          {a.kind === "image" && !a.inBin && opener && <Act wide label="Image to video (i2v)" k="M" onClick={() => animate.mutate()} disabled={animate.isPending} title={`A new video with this image as the first frame, on ${openerName} (the video model used last).`} />}
          {a.kind === "video" && !a.inBin && carrier && <Act label="Extend" k="C" onClick={() => carryOn.mutate()} disabled={carryOn.isPending} title={fromLastFrame ? "A new clip whose first frame is the last frame of this one, same model and parameters. The frame is saved as an image in your library." : "A new clip that carries on from the end of this one (previous clip). You can pick the frame it starts from."} />}
          {a.kind === "video" && !a.inBin && <Act label="Trim" k="T" pressed={trim} onClick={() => setTrim(!trim)} title="Trim: pick an in and an out, then copy, split or remove the range, save its frames, or generate between them." />}
          {a.kind === "video" && !a.inBin && <Act label={saveFrame.isPending ? "Saving…" : "Save frame"} k="G" onClick={() => saveFrame.mutate()} disabled={saveFrame.isPending} title="Pause the video on the frame you want, then save it as an image in your library." />}
          {a.kind === "video" && !a.inBin && a.hasSound && <Act label={takeSound.isPending ? "Extracting…" : "Extract audio"} onClick={() => takeSound.mutate()} disabled={takeSound.isPending} title="Its audio track as an audio file of its own in your library: for another clip, or as music." />}
          {a.kind === "audio" && !a.inBin && follower && <Act wide label="Use as voice sample" onClick={() => follow.mutate()} disabled={follow.isPending} title="A new video in which the person speaks with this voice sample." />}
          {a.kind !== "audio" && !a.inBin && !g && <Act label="PNG info" k="P" onClick={() => setInfo(true)} title="The generation parameters embedded in the file: prompt, checkpoint, LoRAs and sampling settings, whether your ComfyUI has them, and sending them to a form." />}
          {onCompare && a.kind !== "audio" && <Act label="Compare" k="X" pressed={comparing} onClick={onCompare} title="Pin this one and move to another with the arrow keys: side by side, videos in step, two pictures also with a wipe" />}
          {!a.inBin && <Act label={a.kept ? "Kept" : "Keep"} k="S" pressed={a.kept} onClick={() => keep.mutate(!a.kept)} title={a.kept ? "Kept: it stays. Click to let it go to the bin after a day again." : "Keep it: it never goes to the bin on its own."} />}
          <Act label="Download" k="D" onClick={download} title="Download the file" />
        </div>
        {(saveFrame.isError || takeSound.isError || animate.isError || carryOn.isError || cutRange.isError || between.isError || extendHere.isError || frameAt.isError) && <span className="-mt-3 text-warn-ink">{(saveFrame.error ?? takeSound.error ?? animate.error ?? carryOn.error ?? cutRange.error ?? between.error ?? extendHere.error ?? frameAt.error)?.message}</span>}

        {g && (
          <div className="flex flex-col gap-3">
            <Made g={g} recipe={recipe} asset={a} />
          </div>
        )}

        {(sources.length > 0 || detail.data?.source) && (
          <div className="flex flex-col gap-2">
            <SectionTitle>Source</SectionTitle>
            <Strip
              items={[
                ...(detail.data?.source ? [{ asset: detail.data.source.asset, name: detail.data.source.asset.shownName || detail.data.source.asset.name || undefined, caption: detail.data.source.range ? `${clock(detail.data.source.range.startMs)}–${clock(detail.data.source.range.endMs)} of it` : a.origin === "edited" ? "mirrored from it" : a.kind === "image" ? "frame of it" : "cut from it" }] : []),
                ...sources.map((s) => {
                  // a prompt-kit picture says whose it is; any other, its own name
                  const kit = kitNames.get(s.asset.id);
                  return kit ? { asset: s.asset, name: kit.name, kit: true, caption: kit.what } : { asset: s.asset, name: s.asset.shownName || s.asset.name || undefined, caption: ROLES[s.role] ?? s.role };
                }),
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

        {!a.inBin && a.kind === "image" && (
          <div className="flex flex-col gap-2">
            <SectionTitle>Image tools</SectionTitle>
            <div className="grid grid-cols-2 gap-1.5">
              {(["u", "f", "b"] as const).filter((k) => toolFor(k)).map((k) => (
                <Act key={k} label={OPS[k]!.label} k={k.toUpperCase()} disabled={queued.isPending} title={`${OPS[k]!.label}: queued at once with the image's generation parameters.`} onClick={() => quick(k)} />
              ))}
              <Act label="Mirror ↔" disabled={mirror.isPending} title="A mirrored copy, left and right swapped: a new picture beside this one, kept, its source remembered. Instant, no GPU. For a keyframe that faces the wrong way for the clip before." onClick={() => mirror.mutate("horizontal")} />
              <Act label="Mirror ↕" disabled={mirror.isPending} title="A mirrored copy, top and bottom swapped: a new picture beside this one, kept, its source remembered. Instant, no GPU." onClick={() => mirror.mutate("vertical")} />
            </div>
            {mirror.isError && <span className="text-warn-ink">{mirror.error.message}</span>}
            <ChangePicker madeWith={recipe} keys={Object.fromEntries((["i", "e", "r"] as const).flatMap((k) => (toolFor(k) ? [[toolFor(k)!.id, k]] : [])))} start={openTool} />
          </div>
        )}

        {!a.inBin && (
          <div className="flex flex-col gap-2">
            <SectionTitle>Put it in</SectionTitle>
            {/* one row each, the name left and one control right, as in the forms */}
            {a.kind !== "audio" && <TimelinePicker asset={a} />}
            {a.kind === "image" && <ReferencePicker asset={a} onDone={leave} />}
            <FolderPicker asset={a} />
          </div>
        )}

        <details className="group rounded-lg border border-line">
          <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs font-semibold text-ink-2 hover:text-ink"><ChevronDown size={13} className="transition-transform group-open:rotate-180" /> File details</summary>
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-line p-3">
            {a.name && <Row label="Name">{a.name}</Row>}
            {a.width && a.height ? <Row label="Resolution">{a.width} × {a.height}</Row> : null}
            {a.kind === "video" && a.durationMs ? <Row label="Duration">{(a.durationMs / 1000).toFixed(1)} s{a.fps ? `, ${Math.round(a.fps)} fps` : ""}</Row> : null}
            {a.kind === "video" && a.durationMs ? <Row label="Audio">{a.hasSound ? "Yes" : "No"}</Row> : null}
            {g?.resolved.overlap?.headMs ? <Row label="Head overlap">The first {(g.resolved.overlap.headMs / 1000).toFixed(1)} s repeat the end of the previous clip. A timeline skips them.</Row> : null}
            {g?.resolved.overlap?.tailMs ? <Row label="Tail overlap">The last {(g.resolved.overlap.tailMs / 1000).toFixed(1)} s repeat the start of the next clip. A timeline skips them.</Row> : null}
            <Row label="File">{FORMATS[a.mime] ?? a.mime}, {mb(a.bytes)}</Row>
            {a.path && <Row label={a.inBin ? "Was at" : "Path"}><span className="font-mono text-xs break-all">{a.path}</span></Row>}
            <Row label="Created">{made.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} at {made.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} ({when(a.createdAt)})</Row>
            {g && <Row label="Render time">{took(g.tookMs)}</Row>}
          </dl>
        </details>

        {!a.inBin && (
          <button type="button" onClick={() => void toBin()} className="flex h-9 items-center justify-center gap-2 self-start rounded-lg px-3 text-ink-2 hover:bg-warn-wash hover:text-warn-ink">
            <Trash2 size={14} /> Move to the bin <Kbd>Del</Kbd>
          </button>
        )}
      </div>
    </aside>
  );
}
