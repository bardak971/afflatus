import { CopyPlus, Download as DownloadIcon, ExternalLink, FileDown, Link2, MoreHorizontal, Play, X } from "lucide-react";
import type { Entity, PresetDef } from "./api";
import { ContextMenu, useMenu, type MenuItem } from "./ContextMenu";
import { useRecipes } from "./data";
import { fileLabel, gb, recipeLabel } from "./format";
import { PresetFiles, usePresetFetch } from "./PresetFiles";
import { savePresetFile } from "./presetFile";
import { kitHref } from "./screens/kit/link";
import { copyText } from "./secureContext";
import { Button, cx, Help } from "./ui";

/** Inputs a cell says together, under one label: the sampler and its scheduler, the two shifts of a video with sound. */
const PAIRS: Array<{ ids: [string, string]; label: string; join: string }> = [
  { ids: ["sampler", "scheduler"], label: "Sampler · scheduler", join: " · " },
  { ids: ["shiftVideo", "shiftAudio"], label: "Shift · video / sound", join: " / " },
];

const MODEL_FILE = /\.(safetensors|gguf|ckpt|pt|pth)$/i;

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

  const isFile = (k: string, v: unknown) => recipe?.inputs.find((i) => i.id === k)?.type === "model" || (typeof v === "string" && MODEL_FILE.test(v));
  const value = (k: string, v: unknown) => {
    if (isFile(k, v)) return fileLabel(String(v));
    if (typeof v === "boolean") return v ? "on" : "off";
    if (typeof v === "object" && v !== null) return JSON.stringify(v);
    return String(v);
  };
  const labelOf = (k: string) => recipe?.inputs.find((i) => i.id === k)?.label ?? k;
  // the model files first and wide (their names are long), then each pair in one cell, then the rest in their order
  const entries = Object.entries(def.inputs);
  const taken = new Set<string>();
  const cells: Array<{ key: string; label: string; text: string; file: boolean }> = [];
  for (const [k, v] of entries) {
    if (!isFile(k, v)) continue;
    cells.push({ key: k, label: labelOf(k), text: value(k, v), file: true });
    taken.add(k);
  }
  for (const [k, v] of entries) {
    if (taken.has(k)) continue;
    const pair = PAIRS.find((p) => p.ids.includes(k) && p.ids.every((id) => id in def.inputs));
    if (pair) {
      cells.push({ key: pair.ids.join("+"), label: pair.label, text: pair.ids.map((id) => value(id, def.inputs[id])).join(pair.join), file: false });
      for (const id of pair.ids) taken.add(id);
    } else {
      cells.push({ key: k, label: labelOf(k), text: value(k, v), file: false });
      taken.add(k);
    }
  }

  const link = `${window.location.origin}${kitHref("preset", e.id)}`;
  const moreItems: MenuItem[] = [
    { label: "Copy link", icon: <Link2 size={14} />, run: () => void copyText(link).catch(() => {}) },
    { label: "Save as a file", icon: <FileDown size={14} />, note: "a file another Afflatus imports", run: () => savePresetFile(e) },
  ];
  const several = (def.files?.filter((f) => !f.optional).length ?? 0) > 1;

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

      <PresetFiles id={e.id} def={def} fetch={fetch} inHead />

      {/* its licence in one line, marked until it is accepted (the theme's warning colour is a red: only the mark wears it); what matters in it behind the ?, in full at its link */}
      {def.licence && (
        <div className={cx("flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-[13px] leading-snug", fetch.accepted ? "border-line text-ink-2" : "border-line-strong bg-panel")}>
          {!fetch.accepted && <span aria-hidden className="font-bold text-warn-ink">!</span>}
          <span className="min-w-0">
            <span className="font-semibold text-ink">{def.licence.name}</span>
            {fetch.accepted ? " · accepted" : `: read it before you fetch the file${several ? "s" : ""}.`}
            {def.licence.url && <> <a href={def.licence.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold underline underline-offset-2">Read it <ExternalLink size={11} /></a></>}
            {def.licence.note && <> <Help title={def.licence.name} text={def.licence.note} /></>}
          </span>
        </div>
      )}

      {more.menu && <ContextMenu at={more.menu.at} label={`More actions on ${e.name}`} items={moreItems} onClose={more.close} />}
    </div>
  );
}
