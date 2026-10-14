import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, Film, Music, Plus, Star, Trash2, Undo2, Wand2, type LucideIcon } from "lucide-react";
import { isShown, type InputSpec, type LoraValue, type ReferenceValue, type SizeValue } from "@afflatus/core";
import { useAddToTimeline, useLast, useOpenInComfy, useStartTimeline } from "../actions";
import { api, thumbUrl, type Asset, type AssetDetail, type Opened, type RecipeInfo } from "../api";
import { ContextMenu, useMenu } from "../ContextMenu";
import { useEntities, useFamilies, useRecipes, useSetup, useTimelines, type useAsset } from "../data";
import { useOpenNewDraft } from "../draft";
import { groupTitle, keysShown, sideGroups, type ActionId, type ItemAction } from "../itemActions";
import { Kbd } from "../Keys";
import { modelGroups } from "../picker";
import { clock, fileLabel, hourMinute, leftWords, notReady, plural, recipeLabel, size, took, UI_LOCALE, when } from "../format";
import { Select } from "../Select";
import { Button, cx, Help, SectionTitle } from "../ui";
import { leftOf } from "../screens/library/justify";
import { daysSaid, unkeptMs, useKeepFor } from "../keepFor";
import { FieldRow } from "../fields";
import { ModelLink } from "../ModelLink";
import { FORMATS } from "./shared";
import { SeedButton } from "./SeedButton";
import { ViewerHeader } from "./ViewerHeader";
import type { ViewerActions } from "./useViewerActions";
import { useCopied } from "../hooks";

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
  const { copied, copy: copyIt } = useCopied();
  const copy = (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); copyIt(text); }}
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

/** One thing to do with the item: a word, its key. Pressed: it is on (Kept, Trim). A long label wraps to a second line rather than being cut ("Reuse · new seed", "Remove background"). */
function Act({ icon, label, k, pressed, done, onClick, disabled, title, wide, more }: { icon?: LucideIcon; label: string; k?: ReactNode; pressed?: boolean; done?: boolean; onClick(e: React.MouseEvent<HTMLButtonElement>): void; disabled?: boolean; title?: string; wide?: boolean; more?: boolean }) {
  // just queued: a check and the ok look for a moment (itemActions.tsx `done`)
  const Icon = done ? Check : icon;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-tip={title}
      aria-pressed={pressed}
      className={cx(
        // a neutral focus ring: on a button that can be on (Compare, Trim), the accent ring read as "still on" once left
        "flex min-h-[38px] min-w-0 items-center gap-2 rounded-[10px] border px-2.5 py-1 text-left text-[13px] font-semibold hover:bg-hover focus-visible:outline-ink-3 disabled:cursor-not-allowed disabled:opacity-50",
        done ? "m-ok border-good/50 bg-good/15 text-good" : pressed ? "border-accent bg-accent-wash text-accent" : "border-line bg-raised text-ink hover:border-line-strong",
        wide && "col-span-2",
      )}
    >
      {Icon && <Icon size={14} aria-hidden className={cx("shrink-0", done ? "text-good" : pressed ? "text-accent" : "text-ink-2")} />}
      <span className="line-clamp-2 min-w-0 grow leading-tight">{label}</span>
      {k && <span className="shrink-0 whitespace-nowrap"><Kbd>{k}</Kbd></span>}
      {more && <ChevronDown size={13} aria-hidden className="shrink-0 text-ink-2" />}
    </button>
  );
}

/** One fact of the file: its name (with its ? right after, as every ? of the app follows what it explains), then its value. */
function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex items-center gap-1.5 text-ink-2">{label}{help && <Help text={help} title={label} />}</dt>
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
  const applied = (recipe?.inputs ?? []).filter((i) => !["prompt", "image", "clip", "references", "audio", "seed"].includes(i.type) && g.inputs[i.id] !== undefined && isShown(i, g.inputs, recipe?.inputs));
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
        {typeof g.resolved.seed === "number" && <Cell label="Seed"><SeedButton seed={g.resolved.seed} /></Cell>}
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
/** `crumb`: what the item is called in the trail's breadcrumb once opened (its name when none). */
function Strip({ items, onOpen }: { items: Array<{ asset: Asset; name?: string; kit?: boolean; caption?: string; crumb?: string }>; onOpen(asset: Asset, crumb: string): void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(({ asset, name, kit, caption, crumb }) => (
        <button key={`${asset.id}${caption}`} type="button" onClick={() => onOpen(asset, crumb ?? name ?? "")} aria-label={`Open: ${[name, caption].filter(Boolean).join(", ") || "item"}`} data-tip={name && caption ? `${name} · ${caption}` : undefined} className="flex w-[76px] flex-col gap-0.5 text-left">
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
        options={(timelines.data?.items ?? []).map((t) => ({ value: t.id, label: t.name, note: t.clips ? `${plural(t.clips, "clip")}` : "empty" }))}
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
          return { value: r.id, label: r.title, detail: r.summary, group: r.imported ? "Your workflows" : family?.name, search: family?.name };
        })}
      />
      {start.isError && <span className="text-warn-ink">{start.error.message}</span>}
    </FieldRow>
  );
}


/**
 * The passes the buttons above do not reach: every other way of making a picture from one picture (another model's
 * Inpaint, an imported workflow), the built-in ones and the imported workflows alike. Picking one opens a new draft
 * with the picture in place. Nothing here when the buttons hold them all.
 */
function MorePasses({ madeWith, shown, start }: {
  /** What the picture was made with: that model's own tools are listed first, and stand out. */
  madeWith?: RecipeInfo;
  /** The recipes the pass buttons use: not listed again. */
  shown: Set<string>;
  start: { mutate(id: string): void; isPending: boolean };
}) {
  const recipes = useRecipes();
  const setup = useSetup();
  const on = useFamilies().isOn;
  const pictures = (recipes.data?.recipes ?? []).filter((r) => on(r.family) && r.output === "image");
  const all = pictures.filter((r) => !shown.has(r.id) && r.inputs.some((i) => i.type === "image" && i.role === "source" && !i.optional));
  if (!all.length) return null;
  const online = setup.data?.comfy.online ?? false;
  const mine = madeWith ? modelGroups(pictures, recipes.data?.families ?? []).find((group) => group.recipes.some((r) => r.id === madeWith.id)) : undefined;
  const own = new Set(all.filter((r) => mine?.recipes.includes(r)).map((r) => r.id));
  const ways = [...all.filter((r) => own.has(r.id)), ...all.filter((r) => !own.has(r.id))];
  return (
    <Select
      dashed
      icon={<Wand2 size={15} className="shrink-0" />}
      label="More passes"
      placeholder={start.isPending ? "Opening…" : `More passes · ${ways.length}`}
      searchHint="Search passes or models"
      value=""
      onChange={(id) => start.mutate(id)}
      options={ways.map((r) => {
        const family = recipes.data?.families.find((f) => f.id === r.family);
        const why = setup.isSuccess ? notReady(setup.data.recipes.find((x) => x.id === r.id), online) : null;
        const note = why ? "not ready" : undefined;
        if (own.has(r.id)) return { value: r.id, label: r.title, note, detail: r.summary, group: `${mine!.name} · source model`, search: `${family?.name ?? ""} ${mine!.name}`, marked: true };
        return { value: r.id, label: r.title, note, detail: r.summary, group: family?.name ?? "Your workflows", search: family?.name };
      })}
    />
  );
}

/** A sound as a timeline's music: the list's Timeline submenu, from a button. */
function MusicPicker({ action }: { action: ItemAction | undefined }) {
  const menu = useMenu<true>();
  if (!action) return null;
  return (
    <FieldRow label="Timeline">
      <Button size="sm" className="justify-start" disabled={action.disabled} data-tip={action.disabled && action.note ? `Timeline: ${action.note}` : "As the music of a timeline"} onClick={(e) => menu.open(e, true)}>
        <Music size={14} /> As music of… <ChevronDown size={13} />
      </Button>
      {menu.menu && action.items && <ContextMenu at={menu.menu.at} label="As the music of a timeline" items={action.items} onClose={menu.close} />}
    </FieldRow>
  );
}

/**
 * Everything about the item, beside it: what it is and where it is filed, whether it is kept, the item's list as
 * buttons in its groups (Make from it, Passes, the tools, Look), how it was made, where it came from and what it was
 * used in, where to put it, and the file's details. Each action shows once: Keep in the line under the name, the seed
 * in its cell, the folder in its chip, the name renamed in place.
 */
export function ViewerSidebar({ acts, list, asset, detail, trail, onTrail: setTrail, items, naming, onNaming, onClose }: {
  acts: ViewerActions;
  /** The item's list (itemActions.tsx), as the viewer does it. */
  list: ItemAction[];
  /** The item as it was listed (see ViewerHeader). */
  asset: Asset;
  detail: ReturnType<typeof useAsset>;
  /** The items followed from the first one: "made from" and "used to make"; Back steps out of it. */
  trail: Asset[];
  onTrail(trail: Asset[]): void;
  /** The list it was opened from, for "n of m". */
  items?: Asset[];
  /** The name is being edited in place (F2, or a click on it). */
  naming: boolean;
  onNaming(naming: boolean): void;
  onClose(): void;
}) {
  const { a, g, recipe, madeWith, recipes, leave, reuse, saveFrame, takeSound, animate, carryOn, cutRange, between, extendHere, mirror, follow, toolFor, openTool } = acts;
  /** An action's own list (Image to video's models, Motion transfer's), open under its button. */
  const choose = useMenu<ItemAction>();
  const family = recipes.data?.families.find((f) => f.id === (recipe?.family ?? g?.family));
  const title = recipe ? recipeLabel(family?.name, recipe.title) : g ? "Generated with a recipe that is no longer here" : a.origin === "uploaded" ? "Uploaded" : a.origin === "generated" ? "Generated" : a.origin === "exported" ? "Timeline export" : a.origin === "frame" ? "Video frame" : a.origin === "edited" ? "Edited copy" : a.origin === "imported" && a.kind === "audio" ? "Extracted audio" : "Imported";
  const made = new Date(a.createdAt);
  const sources = detail.data?.id === a.id ? detail.data.sources : [];
  const usedIn = detail.data?.id === a.id ? detail.data.usedIn : [];
  const kitNames = useKitNames();
  // what each step of the trail is called in the breadcrumb: a source by its name or its role ("first frame"), a kit picture by whose it is ("Her · person")
  const [crumbs, setCrumbs] = useState<Record<string, string>>({});
  const stepTo = (next: Asset, crumb: string) => {
    if (crumb) setCrumbs((c) => ({ ...c, [next.id]: crumb }));
    setTrail([...trail, next]);
  };
  const byId = (id: ActionId) => list.find((x) => x.id === id);
  const keep = byId("keep");
  // how long it has before it goes to the bin by itself (Settings › Storage); null: nothing goes on its own
  const unkeptDays = useKeepFor((s) => s.unkeptDays);
  const left = leftOf(a, Date.now(), unkeptMs(unkeptDays));
  const bin = byId("bin");
  const passTools = new Set((["u", "f", "h", "b", "i", "e", "r"] as const).flatMap((k) => (toolFor(k) ? [toolFor(k)!.id] : [])));
  // each item starts at the top of the side: kept scrolled down from the last one (Details), the actions were out of sight
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [a.id]);
  const failed = reuse.error ?? saveFrame.error ?? takeSound.error ?? animate.error ?? carryOn.error ?? cutRange.error ?? between.error ?? extendHere.error ?? mirror.error ?? follow.error ?? openTool.error;
  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l border-line bg-panel">
      <ViewerHeader acts={acts} asset={asset} detail={detail} title={title} trail={trail} crumbs={crumbs} onTrail={setTrail} items={items} naming={naming} onNaming={onNaming} onClose={onClose} />
      <div ref={scroller} className="flex min-h-0 grow flex-col gap-4 overflow-y-auto px-5 py-3.5">
        {/* whether it stays: one line, always there (no jump when it is kept), with the one Keep of the side */}
        {a.inBin ? (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-warn-wash px-3 py-2 text-warn-ink">
            <span>In the bin.</span>
            <Button size="sm" tone="danger" disabled={bin?.disabled} onClick={() => bin?.run?.()}><Undo2 size={14} /> Put back</Button>
          </div>
        ) : a.kept ? (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-raised px-3 py-2 text-ink-2">
            <span className="flex items-center gap-1.5"><Star size={13} fill="currentColor" className="text-accent" /> Kept</span>
            <Button size="sm" tone="quiet" data-tip={keep?.tip} onClick={() => keep?.run?.()}>Unkeep <Kbd>S</Kbd></Button>
          </div>
        ) : left === null ? (
          // nothing goes to the bin on its own (Settings › Storage): not kept says so, without a clock
          <div className="flex items-center justify-between gap-3 rounded-xl bg-raised px-3 py-2 text-ink-2">
            <span className="flex items-center gap-1.5">Not kept <Help text="Renders nobody kept stay until you bin them: Settings › Storage sends nothing to the bin on its own. Keep marks the ones that matter." /></span>
            <Button size="sm" tone="quiet" data-tip={keep?.tip} onClick={() => keep?.run?.()}><Star size={13} /> Keep <Kbd>S</Kbd></Button>
          </div>
        ) : (
          // expiring is the normal life of a render, not a fault: the warn look only in its last hour, as the status bar's chip
          <div className={cx("flex items-center justify-between gap-3 rounded-xl px-3 py-2", left < 3_600_000 ? "bg-warn-wash text-warn-ink" : "bg-raised text-ink-2")}>
            <span className="flex items-center gap-1.5">
              Expires in {leftWords(left)}
              <Help text={`Renders nobody kept go to the bin by themselves ${daysSaid(unkeptDays)} after they were made (or unkept); Settings › Storage says how long. Keep holds one until you bin it.`} />
            </span>
            <Button size="sm" tone="danger" onClick={() => keep?.run?.()}><Star size={13} /> Keep <Kbd>S</Kbd></Button>
          </div>
        )}

        {/* the item's list as buttons, in its groups: every pass with its key, nothing behind a menu */}
        {sideGroups(list).map(({ group, actions }) => (
          <div key={group} className="flex flex-col gap-1.5">
            <SectionTitle>{groupTitle(group, a.kind)}</SectionTitle>
            <div className="grid grid-cols-2 gap-1.5">
              {actions.map((x) => (
                // one with a choice of its own (a model to open on): its list under it; its key still takes the one used last
                <Act key={x.id} icon={x.icon} label={x.label} k={x.key && keysShown("viewer", x.id) ? x.key : undefined} pressed={x.pressed} done={x.done} disabled={x.disabled} title={x.disabled && x.note ? `${x.label}: ${x.note}` : x.tip} more={Boolean(x.items?.length) && x.id !== "timeline" && x.id !== "move"} onClick={(e) => (x.items?.length && x.id !== "timeline" && x.id !== "move" ? choose.open(e, x) : x.run?.())} />
              ))}
            </div>
            {group === "passes" && !a.inBin && <MorePasses madeWith={madeWith} shown={passTools} start={openTool} />}
          </div>
        ))}
        {failed && <span className="-mt-2 text-warn-ink">{failed.message}</span>}
        {choose.menu?.subject.items && <ContextMenu at={choose.menu.at} label={choose.menu.subject.label} items={choose.menu.subject.items} onClose={choose.close} />}

        {g && (
          <div data-viewer-params className="flex scroll-mt-3 flex-col gap-3">
            <Made g={g} recipe={recipe} asset={a} />
          </div>
        )}

        {(sources.length > 0 || detail.data?.source) && (
          <div className="flex flex-col gap-2">
            <SectionTitle>Source</SectionTitle>
            <Strip
              items={[
                ...(detail.data?.source ? [{ asset: detail.data.source.asset, name: detail.data.source.asset.shownName || detail.data.source.asset.name || undefined, caption: detail.data.source.range ? `${clock(detail.data.source.range.startMs)}–${clock(detail.data.source.range.endMs)} of it` : a.origin === "edited" ? (a.kind === "video" ? "its sound removed" : "mirrored from it") : a.kind === "image" ? "frame of it" : "cut from it" }] : []),
                ...sources.map((s) => {
                  // a prompt-kit picture says whose it is; any other, its own name
                  const kit = kitNames.get(s.asset.id);
                  const name = s.asset.shownName || s.asset.name || undefined;
                  return kit ? { asset: s.asset, name: kit.name, kit: true, caption: kit.what, crumb: `${kit.name} · ${kit.what}` } : { asset: s.asset, name, caption: ROLES[s.role] ?? s.role, crumb: name ?? ROLES[s.role] ?? s.role };
                }),
              ]}
              onOpen={stepTo}
            />
          </div>
        )}
        {usedIn.length > 0 && (
          <div className="flex flex-col gap-2">
            <SectionTitle>Used in</SectionTitle>
            <Strip items={usedIn.map((u) => ({ asset: u }))} onOpen={stepTo} />
          </div>
        )}

        {!a.inBin && (
          <div className="flex flex-col gap-2">
            <SectionTitle>Put it in</SectionTitle>
            {/* one row each, the name left and one control right, as in the forms; the folder is the chip at the top */}
            {a.kind === "audio" ? <MusicPicker action={byId("timeline")} /> : <TimelinePicker asset={a} />}
            {a.kind === "image" && <ReferencePicker asset={a} onDone={leave} />}
          </div>
        )}

        {/* Details (P) unfolds this for an item made here without parameters of its own (a cut, a frame, an export) */}
        <details data-viewer-file className="group rounded-lg border border-line">
          <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs font-semibold text-ink-2 hover:text-ink"><ChevronDown size={13} className="transition-transform group-open:rotate-180" /> File details</summary>
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-line p-3">
            {a.name && <Row label="Name">{a.name}</Row>}
            {a.width && a.height ? <Row label="Resolution">{a.width} × {a.height}</Row> : null}
            {a.kind === "video" && a.durationMs ? <Row label="Duration">{(a.durationMs / 1000).toFixed(1)} s{a.fps ? `, ${Math.round(a.fps)} fps` : ""}</Row> : null}
            {a.kind === "video" && a.durationMs ? <Row label="Audio">{a.hasSound ? "Yes" : "No"}</Row> : null}
            {g?.resolved.overlap?.headMs ? <Row label="Head overlap" help="The first seconds repeat the end of the previous clip. A timeline skips them.">{(g.resolved.overlap.headMs / 1000).toFixed(1)} s</Row> : null}
            {g?.resolved.overlap?.tailMs ? <Row label="Tail overlap" help="The last seconds repeat the start of the next clip. A timeline skips them.">{(g.resolved.overlap.tailMs / 1000).toFixed(1)} s</Row> : null}
            <Row label="File">{FORMATS[a.mime] ?? a.mime}, {size(a.bytes)}</Row>
            {a.path && <Row label={a.inBin ? "Was at" : "Path"}><span className="font-mono text-xs break-all">{a.path}</span></Row>}
            <Row label="Created">{made.toLocaleDateString(UI_LOCALE, { day: "numeric", month: "long", year: "numeric" })} at {hourMinute(made)} ({when(a.createdAt)})</Row>
            {g && <Row label="Render time">{took(g.tookMs)}</Row>}
          </dl>
        </details>

        {!a.inBin && bin && (
          <button type="button" onClick={() => bin.run?.()} className="flex h-9 items-center justify-center gap-2 self-start rounded-lg px-3 text-ink-2 hover:bg-warn-wash hover:text-warn-ink">
            <Trash2 size={14} /> {bin.label} <Kbd>Del</Kbd>
          </button>
        )}
      </div>
    </aside>
  );
}
