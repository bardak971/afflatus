import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Film, Image as ImageIcon, Music, Plus } from "lucide-react";
import { Thumb } from "../../Thumb";
import { fuzzyFilter, REMOVED_RECIPES, removedName } from "@afflatus/core";
import { thumbUrl, type DraftBrief, type FamilyInfo, type RecipeInfo } from "../../api";
import { useRecipes } from "../../data";
import { plural, triedLabel, when } from "../../format";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { Keys } from "../../Keys";
import { Popover } from "../../Popover";
import { cx, SearchField, TwoStep } from "../../ui";

/** When a draft was last changed (or started): the app's one way of saying when (format.ts `when`). */
const changed = (iso: string, now = Date.now()): string => when(iso, now);

const OUTPUT_WORD = { image: ["picture", "pictures"], video: ["take", "takes"], audio: ["sound", "sounds"] } as const;

/** A draft's cover: its newest output, or a dashed box when nothing was made from it. */
function Cover({ d, size }: { d: DraftBrief; size: number }) {
  const style = { width: size, height: size };
  if (d.cover) return <Thumb src={thumbUrl(d.cover)} alt="" loading="lazy" sizes={`${size}px`} style={style} className="shrink-0 rounded-[3px] bg-raised object-cover" />;
  return <span aria-hidden style={style} className="shrink-0 rounded-[3px] border border-dashed border-line-strong" />;
}

/**
 * The open draft as the menu shows it: the list's row (which alone knows its cover and what was made from it), with
 * the model and the name the open draft has now. The row is refreshed only once an edit is saved, so a draft switched
 * to another model read its old model on the button's tip until then.
 */
export function openRow(current: DraftBrief, drafts: DraftBrief[]): DraftBrief {
  const row = drafts.find((d) => d.id === current.id);
  return row ? { ...row, recipe: current.recipe, name: current.name } : current;
}

/**
 * How the drafts' rows name their models, from the models' list (undefined while it comes): the family of a draft's
 * recipe, the other families it was tried on, and the dim line of both ("Wan 2.2 · SDXL"). A recipe taken out of
 * Afflatus reads by the name it had ("Wan Animate 2 (removed)", as the queue says it), never its id.
 */
export function draftWords(data: { recipes: RecipeInfo[]; families: FamilyInfo[] } | undefined) {
  const recipeOf = (id: string) => data?.recipes.find((r) => r.id === id);
  const familyOf = (id: string) => {
    const r = recipeOf(id);
    return data?.families.find((f) => f.id === r?.family)?.name ?? r?.family ?? REMOVED_RECIPES[id] ?? "";
  };
  // a removed recipe's family is its id's first word ("wananimate"): what it made is counted as its own, not another try
  const ownFamily = (id: string) => recipeOf(id)?.family ?? (REMOVED_RECIPES[id] ? id.split(".")[0] : undefined);
  const familyName = (id: string) => data?.families.find((f) => f.id === id)?.name ?? id;
  // a draft is an idea, its models are tries of it: the other families it made something with, the newest first
  const othersOf = (d: DraftBrief) => (d.models ?? []).filter((m) => m.family !== ownFamily(d.recipe));
  const modelLine = (d: DraftBrief) => {
    const r = recipeOf(d.recipe);
    const others = othersOf(d).map((m) => familyName(m.family));
    return r ? triedLabel(familyOf(d.recipe), others, r.title) : [removedName(d.recipe) ?? d.recipe, ...others].join(" · ");
  };
  return { recipeOf, familyOf, ownFamily, othersOf, modelLine };
}

/**
 * The drafts, as the command bar's rows: the cover, the name, the models it was tried on on a dim line (its form's
 * first), and on the right how many outputs it has (by model when it was tried on several) and when it was last changed. Opens from the head of the Create panel; typing narrows
 * the list, the arrow keys move in it, Enter opens. A draft with no prompt is named after its model.
 */
export function DraftMenu({ drafts: rows, open: current, titleOf, onPick, onNew, onClearUnused, menuOf }: {
  drafts: DraftBrief[];
  open: DraftBrief | null;
  /** What a draft is called: its name, else the start of its prompt, else "" (named after its model here). */
  titleOf(d: DraftBrief): string;
  onPick(id: string): void;
  onNew(): void;
  onClearUnused(): Promise<unknown>;
  /** A draft's right-click menu: the draft's list, as every place shows it (projects/kindActions.tsx). */
  menuOf(d: DraftBrief): MenuItem[];
}) {
  const rowMenu = useMenu<DraftBrief>();
  // the open draft's row says the model it is on now, in the list as on the button
  const drafts = useMemo(
    () => (current ? rows.map((d) => (d.id === current.id ? openRow(current, rows) : d)) : rows),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only what openRow takes of the open draft
    [rows, current?.id, current?.recipe, current?.name],
  );
  const recipes = useRecipes();
  const [shown, setShown] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const [clearing, setClearing] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const optionId = (d: DraftBrief) => `${ids}-${d.id}`;

  const { recipeOf, familyOf, ownFamily, othersOf, modelLine } = draftWords(recipes.data);
  const nameOf = (d: DraftBrief) => titleOf(d) || `${familyOf(d.recipe) || "Untitled"} draft`;
  const countOf = (d: DraftBrief) => {
    const n = d.outputs ?? 0;
    if (!n) return "empty";
    const words = OUTPUT_WORD[recipeOf(d.recipe)?.output ?? d.coverKind ?? "image"];
    // tried on several models: how many each made, in the order of the line ("2 + 2 pictures")
    const own = d.models?.find((m) => m.family === ownFamily(d.recipe));
    const each = [...(own ? [own] : []), ...othersOf(d)];
    return `${each.length > 1 ? each.map((m) => m.outputs).join(" + ") : n} ${n === 1 ? words[0] : words[1]}`;
  };

  // drafts that read the same (three "Wan 2.2 draft", one prompt sent twice): their dim line tells them apart by
  // the prompt when they were named alike, else by when they were started
  const repeats = useMemo(() => {
    const seen = new Map<string, number>();
    for (const d of drafts) seen.set(nameOf(d), (seen.get(nameOf(d)) ?? 0) + 1);
    return seen;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nameOf is new at every render and reads the recipes, listed instead
  }, [drafts, recipes.data]);
  const subLine = (d: DraftBrief) => {
    if ((repeats.get(nameOf(d)) ?? 0) < 2) return modelLine(d);
    const prompt = d.title.trim();
    if (d.name && prompt && prompt !== nameOf(d)) return `${modelLine(d)} · ${prompt}`;
    return d.createdAt ? `${modelLine(d)} · started ${changed(d.createdAt)}` : modelLine(d);
  };

  const found = useMemo(
    () => fuzzyFilter(drafts, query, (d) => `${nameOf(d)} ${d.title} ${modelLine(d)}`),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nameOf and modelLine are new at every render and read the recipes, listed instead
    [drafts, query, recipes.data],
  );
  // the unused drafts (no prompt, no name, nothing made: the ones Clear deletes) fold under one row at the foot, with
  // Clear on it, the open one staying in its place: a list of "Wan 2.2 draft · empty" three times hid the drafts that
  // hold work. One idea of "unused" for both, so the row's count and what Clear deletes are the same. A search looks
  // through them all.
  const [emptyShown, setEmptyShown] = useState(false);
  const holds = (d: DraftBrief) => !d.unused || d.id === current?.id;
  const list = query || emptyShown ? found : found.filter(holds);
  const empties = query ? 0 : found.length - found.filter(holds).length;
  const close = () => {
    setShown(false);
    setQuery("");
  };
  /** A line of a row's menu closes the list before it runs: what it does (a question, another draft) is seen over the Studio. */
  const closing = (items: MenuItem[]): MenuItem[] =>
    items.map((it) => (it === "—" ? it : { ...it, ...(it.items ? { items: closing(it.items) } : {}), ...(it.run ? { run: () => { close(); it.run!(); } } : {}) }));
  const active = shown ? list[at] : undefined;
  // the row the arrows are on stays in sight in a long list
  useEffect(() => {
    if (active) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the row the arrows are on changes
  }, [active?.id]);
  const pick = (id: string) => {
    close();
    if (id !== current?.id) onPick(id);
  };
  const onKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setAt((i) => Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && list[at]) {
      e.preventDefault();
      pick(list[at]!.id);
    }
  };

  const shownRow = current ? openRow(current, rows) : null;
  const Kind = current?.coverKind === "video" ? Film : current?.coverKind === "audio" ? Music : ImageIcon;
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={shown}
        aria-label={`Drafts: ${current ? nameOf(current) : "no draft yet"}`}
        data-tip={shownRow ? modelLine(shownRow) : undefined}
        onClick={() => (shown ? close() : (setShown(true), setAt(Math.max(0, list.findIndex((d) => d.id === current?.id)))))}
        className={cx("flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg border bg-raised pr-2.5 pl-1.5 text-left font-semibold", shown ? "border-accent" : "border-line-strong hover:border-accent")}
      >
        {shownRow ? <Cover d={shownRow} size={24} /> : <Kind size={14} className="text-ink-3" />}
        <span className={cx("min-w-0 grow truncate", current && !titleOf(current) && "text-ink-2")}>{current ? nameOf(current) : "No draft yet"}</span>
        {(shownRow?.outputs ?? 0) > 0 && <span className="shrink-0 font-mono text-[11px] font-normal text-ink-3">{shownRow!.outputs}</span>}
        <ChevronDown size={14} className="shrink-0 text-ink-2" />
      </button>
      {shown && (
        <Popover anchor={button} onClose={close} label="Drafts" width={420} height={560}>
          <SearchField
            look="head"
            autoFocus
            data-search="drafts"
            value={query}
            onChange={(text) => {
              setQuery(text);
              setAt(0);
            }}
            onKeyDown={onKeys}
            role="combobox"
            aria-expanded
            aria-controls={`${ids}-list`}
            aria-activedescendant={active ? optionId(active) : undefined}
            placeholder="Search drafts by name, prompt or model"
            label="Search drafts"
            className="h-11 gap-2 px-3"
            inputClassName="text-sm"
            end={<Keys keys="Esc" size="sm" />}
          />
          <button type="button" onClick={() => { close(); onNew(); }} className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-3 text-left font-semibold hover:bg-hover">
            <span className="flex h-9 w-9 items-center justify-center rounded-[3px] border border-dashed border-line-strong text-ink-2"><Plus size={14} /></span>
            <span className="grow">New draft</span>
            <span className="text-xs font-normal text-ink-3">the open one stays in the list</span>
          </button>
          <div className="min-h-0 overflow-y-auto py-1">
            <div className="px-3 pt-1.5 pb-1 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{query ? `${list.length} found` : "Recent"}</div>
            <div id={`${ids}-list`} role="listbox" aria-label="Drafts">
              {list.map((d, i) => {
                const isOpen = d.id === current?.id;
                const named = Boolean(titleOf(d));
                return (
                  <button
                    key={d.id}
                    id={optionId(d)}
                    type="button"
                    role="option"
                    aria-selected={i === at}
                    tabIndex={-1}
                    onClick={() => pick(d.id)}
                    onContextMenu={(e) => rowMenu.open(e, d)}
                    onMouseMove={() => setAt(i)}
                    // rounded and inset from the panel's edges, as every list's rows are (a dropdown's, the Projects
                    // panel's): the open one was a square box across the whole panel
                    className={cx(
                      "mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2.5 rounded-lg px-1.5 py-[7px] text-left",
                      isOpen ? "bg-accent-wash shadow-[inset_0_0_0_1px_var(--color-accent)]" : i === at ? "bg-hover" : "",
                    )}
                  >
                    <Cover d={d} size={36} />
                    <span className="flex min-w-0 grow flex-col gap-0.5">
                      <span className={cx("truncate font-semibold", !named && "text-ink-2")}>{nameOf(d)}</span>
                      <span className="truncate text-xs text-ink-3">{subLine(d)}{isOpen ? " · open" : ""}</span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[11px]">
                      <span className="text-ink-2">{countOf(d)}</span>
                      <span className="text-ink-3">{changed(d.updatedAt)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {!list.length && query && <div className="px-3 py-4 text-sm text-ink-3">No draft matches.</div>}
            {empties > 0 && (
              <div className="flex h-10 items-center gap-2 pr-3">
                <button type="button" aria-expanded={emptyShown} data-tip="No prompt, no name and nothing made from them: settings picked and left" onClick={() => setEmptyShown(!emptyShown)} className="flex h-full min-w-0 grow items-center gap-2 px-3 text-left text-xs text-ink-2 hover:text-ink">
                  <ChevronDown size={13} className={cx("shrink-0 transition-transform duration-(--t-pop)", emptyShown && "rotate-180")} />
                  <span className="truncate">{emptyShown ? `Hide the ${plural(empties, "unused draft")}` : `${plural(empties, "unused draft")}`}</span>
                </button>
                <TwoStep
                  label={clearing ? "Clearing…" : "Clear them"}
                  title={`Delete the ${plural(empties, "unused draft")} (the open one stays)`}
                  note="Delete? The open one stays."
                  yes="Delete"
                  cancel="Keep"
                  stay
                  disabled={clearing}
                  onYes={() => {
                    setClearing(true);
                    void onClearUnused().finally(() => setClearing(false));
                  }}
                />
              </div>
            )}
          </div>
          {rowMenu.menu && (
            <ContextMenu
              at={rowMenu.menu.at}
              label="Actions on this draft"
              head={{ title: nameOf(rowMenu.menu.subject), sub: `${modelLine(rowMenu.menu.subject)} · ${countOf(rowMenu.menu.subject)}` }}
              items={closing(menuOf(rowMenu.menu.subject))}
              onClose={rowMenu.close}
            />
          )}
        </Popover>
      )}
    </>
  );
}
