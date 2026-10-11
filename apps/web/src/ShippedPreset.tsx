import { isModelFile } from "@afflatus/core";
import { CopyPlus, Download as DownloadIcon, ExternalLink, FileDown, Link2, MoreHorizontal, Play, X } from "lucide-react";
import type { Entity, PresetDef } from "./api";
import { ContextMenu, useMenu, type MenuItem } from "./ContextMenu";
import { useRecipes } from "./data";
import { fileLabel, gb, recipeLabel } from "./format";
import { PresetFiles, usePresetFetch } from "./PresetFiles";
import { savePresetFile } from "./presetFile";
import { kitHref } from "./screens/kit/link";
import { useSayFailed } from "./sayFailed";
import { copyText } from "./secureContext";
import { useBanners } from "./store";
import { Button, cx, Help } from "./ui";

/** Inputs a cell says together, under one label: the sampler and its scheduler, the two shifts of a video with sound. */
const PAIRS: Array<{ ids: [string, string]; label: string; join: string }> = [
  { ids: ["sampler", "scheduler"], label: "Sampler · scheduler", join: " · " },
  { ids: ["shiftVideo", "shiftAudio"], label: "Shift · video / sound", join: " / " },
];

/** The sampling inputs whose model default is shown when the preset leaves them: what a render of it actually uses. */
const SAMPLING = ["steps", "turboSteps", "cfg", "sampler", "scheduler", "shift", "shiftVideo", "shiftAudio"];

type Cell = { key: string; label: string; text: string; file: boolean };

/**
 * A preset that ships with Afflatus, opened in the Prompt kit: its name, what it is for and who made it, the main action
 * (getting its files while one is missing, else Apply in Studio), Duplicate and the rest in ···; then what it sets as
 * cells (the viewer's Details' look), its files, and its licence in one line. It cannot be changed; a duplicate can.
 */
export function ShippedPreset({ e, onApply, onDuplicate, duplicating, onClose }: {
  e: Extract<Entity, { kind: "preset" }>;
  onApply(): void;
  /** A copy of it in your presets, opened: the kit's own Duplicate. */
  onDuplicate(): void;
  duplicating: boolean;
  onClose(): void;
}) {
  const recipes = useRecipes();
  const def: PresetDef = e.def;
  const recipe = recipes.data?.recipes.find((r) => r.id === def.recipe);
  const family = recipes.data?.families.find((f) => f.id === recipe?.family);
  const fetch = usePresetFetch(e.id, def);
  const more = useMenu<null>();
  const missing = fetch.fetchable.length;

  const isFile = (k: string, v: unknown) => recipe?.inputs.find((i) => i.id === k)?.type === "model" || (typeof v === "string" && isModelFile(v));
  const value = (k: string, v: unknown) => {
    if (isFile(k, v)) return fileLabel(String(v));
    if (typeof v === "boolean") return v ? "on" : "off";
    // a shift of 0 is none typed: the model's own (the recipes' "0 leaves the model's own")
    if (k.startsWith("shift") && v === 0) return "model's own";
    if (v && typeof v === "object" && "width" in v && "height" in v) return `${String(v.width)} × ${String(v.height)}`;
    if (typeof v === "object" && v !== null) return JSON.stringify(v);
    return String(v);
  };
  const labelOf = (k: string) => recipe?.inputs.find((i) => i.id === k)?.label ?? k;
  // the model files first and wide (their names are long), then each pair in one cell, then the rest in their order
  const cellsOf = (values: Record<string, unknown>): Cell[] => {
    const entries = Object.entries(values);
    const taken = new Set<string>();
    const out: Cell[] = [];
    for (const [k, v] of entries) {
      if (!isFile(k, v)) continue;
      out.push({ key: k, label: labelOf(k), text: value(k, v), file: true });
      taken.add(k);
    }
    for (const [k, v] of entries) {
      if (taken.has(k)) continue;
      const pair = PAIRS.find((p) => p.ids.includes(k) && p.ids.every((id) => id in values));
      if (pair) {
        out.push({ key: pair.ids.join("+"), label: pair.label, text: pair.ids.map((id) => value(id, values[id])).join(pair.join), file: false });
        for (const id of pair.ids) taken.add(id);
      } else {
        out.push({ key: k, label: labelOf(k), text: value(k, v), file: false });
        taken.add(k);
      }
    }
    return out;
  };
  const cells = cellsOf(def.inputs);
  // what it leaves to the model, as the model's own defaults: a preset that names only a file still says what a render
  // uses. Turbo (fast) runs its own steps, the full model its steps; what you saved for the model in Studio comes before these
  const fast = def.inputs.fast === true;
  const leftToModel: Record<string, unknown> = {};
  for (const id of SAMPLING) {
    if (id in def.inputs || (fast ? id === "steps" : id === "turboSteps")) continue;
    const spec = recipe?.inputs.find((i) => i.id === id);
    if (spec && "default" in spec && spec.default !== undefined) leftToModel[id] = spec.default;
  }
  const defaults = cellsOf(leftToModel);

  const link = `${window.location.origin}${kitHref("preset", e.id)}`;
  const say = useBanners((b) => b.push);
  const failed = useSayFailed({ id: "kit", href: kitHref("preset", e.id), go: "Open the preset" });
  const moreItems: MenuItem[] = [
    // said in a banner, as the seed is: a menu item shows nothing once it closes
    { label: "Copy link", icon: <Link2 size={14} />, run: () => void copyText(link).then(() => say({ id: `copied:${Date.now()}`, tone: "good", title: "Link copied" }), failed("Could not copy the link")) },
    { label: "Save as a file", icon: <FileDown size={14} />, note: "a file another Afflatus imports", run: () => savePresetFile(e) },
  ];
  const several = (def.files?.filter((f) => !f.optional).length ?? 0) > 1;
  // the licence asks for a look only while there is a file to fetch under it and it was not accepted: with every file in
  // ComfyUI already (fetched by hand, or before), it is the credit line it is
  const toAccept = !fetch.accepted && missing > 0;

  return (
    <div className="flex max-w-[860px] flex-col gap-5">
      <div className="flex flex-col gap-2">
        {/* the name on a line of its own, whole: beside the buttons a long one was cut even on a wide screen */}
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 grow text-[22px] leading-tight font-bold text-balance">{e.name}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={15} /></button>
        </div>
        {/* what it is for, what it is picked by, who made it */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2">
          <span>{recipe ? recipeLabel(family?.name, recipe.title) : `${def.recipe ?? "Any model"} (no such form here)`}</span>
          {def.line && <><span className="text-ink-3">·</span><span>{def.line}</span></>}
          {def.author && <><span className="text-ink-3">·</span><span>by <span className="font-semibold text-ink">{def.author}</span></span></>}
          {def.homepage && <a href={def.homepage} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-semibold underline underline-offset-2">Its page <ExternalLink size={11} /></a>}
          {/* the author's own pages (their GitHub) stay in sight, as the credit they are */}
          {def.links?.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-semibold underline underline-offset-2">{l.label} <ExternalLink size={11} /></a>)}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {/* a file missing: getting it comes first (it asks the licence before), Apply says the render waits for it */}
          {missing > 0 && (
            <Button size="sm" tone="primary" onClick={fetch.go} disabled={fetch.fetchAll.isPending} className="flex items-center gap-1.5">
              <DownloadIcon size={13} /> {missing === 1 ? "Get the file" : `Get the ${missing} files`}{fetch.bytes ? <span className="font-medium opacity-75">{gb(fetch.bytes)}</span> : null}
            </Button>
          )}
          <Button size="sm" tone={missing > 0 ? "plain" : "primary"} onClick={onApply} className="flex items-center gap-1.5">
            <Play size={13} /> Apply in Studio{missing > 0 && <span className="font-medium text-ink-3">· renders once the file{missing > 1 ? "s are" : " is"} in</span>}
          </Button>
          <Button size="sm" onClick={onDuplicate} disabled={duplicating} data-tip="A copy in your presets, opened: it can be changed, and keeps the files and the credit" className="flex items-center gap-1.5"><CopyPlus size={13} /> Duplicate</Button>
          <button type="button" aria-label={`More actions on ${e.name}`} aria-haspopup="menu" data-tip="Copy link, Save as a file" onClick={(ev) => more.open(ev, null)} className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-ink-2 hover:bg-hover hover:text-ink", more.menu ? "border-accent" : "border-line-strong")}>
            <MoreHorizontal size={15} />
          </button>
        </div>
      </div>

      {def.note && <p className="m-0 max-w-[760px] leading-relaxed text-ink-2">{def.note}</p>}

      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
          What it sets <Help title="What it sets" text="Applied in Studio (under Model), it changes only these; everything else follows the model's own defaults and what you saved for it." />
        </span>
        {cells.length === 0 ? (
          <span className="text-ink-2">Nothing beyond the model's defaults.</span>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {cells.map((c) => (
              <div key={c.key} className={cx("flex min-w-0 flex-col gap-0.5 rounded-[10px] border border-line px-3 py-2", c.file && "col-span-3")}>
                <span className="text-[11.5px] text-ink-3">{c.label}</span>
                <span className={cx("font-semibold break-words", c.file && "font-mono text-[12.5px]")}>{c.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {defaults.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
            The rest, from {family?.name ?? "the model"}&rsquo;s defaults <Help title="The model's defaults" text="What the preset leaves alone follows the model's own defaults, shown here; values you saved for this model in Studio's form come first." />
          </span>
          <div className="grid grid-cols-3 gap-2">
            {defaults.map((c) => (
              <div key={c.key} className="flex min-w-0 flex-col gap-0.5 rounded-[10px] border border-dashed border-line px-3 py-2">
                <span className="text-[11.5px] text-ink-3">{c.label}</span>
                <span className="break-words text-ink-2">{c.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <PresetFiles id={e.id} def={def} fetch={fetch} inHead />

      {/* its licence in one line, marked until it is accepted (the theme's warning colour is a red: only the mark wears it); what matters in it behind the ?, in full at its link */}
      {def.licence && (
        <div className={cx("flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-[13px] leading-snug", toAccept ? "border-line-strong bg-panel" : "border-line text-ink-2")}>
          {toAccept && <span aria-hidden className="font-bold text-warn-ink">!</span>}
          <span className="min-w-0">
            <span className="font-semibold text-ink">{def.licence.name}</span>
            {toAccept ? `: read it before you fetch the file${several ? "s" : ""}.` : fetch.accepted && missing > 0 ? " · accepted" : ""}
            {def.licence.url && <> <a href={def.licence.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold underline underline-offset-2">Read it <ExternalLink size={11} /></a></>}
            {def.licence.note && <> <Help title={def.licence.name} text={def.licence.note} /></>}
          </span>
        </div>
      )}

      {more.menu && <ContextMenu at={more.menu.at} label={`More actions on ${e.name}`} items={moreItems} onClose={more.close} />}
    </div>
  );
}
