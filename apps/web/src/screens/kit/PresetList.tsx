import { useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { Entity } from "../../api";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { useRecipes } from "../../data";
import { usePresetFiles } from "../../PresetFiles";
import { buttonClass, cx } from "../../ui";
import { Badge, Mark, Row } from "./Row";

/** The author a shipped preset is filed under when its file names none. */
const UNNAMED_AUTHOR = "Shipped";
/** Who a shipped preset is by, as its file says; a shipped file that names nobody is filed under one word. */
export const authorOf = (e: Entity) => (e.kind === "preset" && e.def.author?.trim()) || UNNAMED_AUTHOR;

/**
 * The presets the search leaves, grouped by the model they are for, with one row of filters: the model
 * (as the list groups), yours, and the ones whose files are missing. Who made a shipped preset is the
 * badge on its row. Above the rows, what the list's head holds for every kind (the new button, the import).
 */
export function PresetList({ found, open, onSelect: select, onMenu, children }: {
  /** What the search leaves of the tab. */
  found: Entity[];
  /** The item open on the right. */
  open: string | null;
  onSelect(id: string): void;
  onMenu(e: Entity, ev: React.MouseEvent): void;
  children?: ReactNode;
}) {
  const recipes = useRecipes();
  const presetFiles = usePresetFiles();
  const [onlyMine, setOnlyMine] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [familyFilter, setFamilyFilter] = useState<string | null>(null);
  const modelMenu = useMenu<null>();
  const recipeList = recipes.data?.recipes ?? [];
  const familyList = recipes.data?.families ?? [];
  /** The family a preset is for: null for any model, undefined when its model is no longer here. */
  const familyOf = (e: Entity) => {
    if (e.kind !== "preset") return undefined;
    if (!e.def.recipe) return null;
    const r = recipeList.find((x) => x.id === e.def.recipe);
    return r ? (familyList.find((f) => f.id === r.family) ?? undefined) : undefined;
  };
  const filesOf = (e: Entity) => presetFiles.data?.items.find((x) => x.id === e.id);
  const missingOf = (e: Entity) => filesOf(e)?.files.filter((f) => !f.have && !f.optional).length ?? 0;
  const presetsShown = found.filter((e) =>
    e.kind === "preset"
    && (!onlyMine || !e.source)
    && (!onlyMissing || missingOf(e) > 0)
    && (!familyFilter || familyOf(e)?.id === familyFilter));
  const presetFamilies = familyList.filter((f) => found.some((e) => familyOf(e)?.id === f.id));
  const missingCount = found.filter((e) => e.kind === "preset" && missingOf(e) > 0).length;
  // the model is a menu, not a row of chips: five families' names took two lines of a 420 px column
  const modelItems: MenuItem[] = [
    { label: "Every model", icon: familyFilter ? undefined : <Check size={14} />, run: () => setFamilyFilter(null) },
    "—",
    ...presetFamilies.map((f) => ({ label: f.name, icon: familyFilter === f.id ? <Check size={14} /> : undefined, run: () => setFamilyFilter(f.id) })),
  ];
  const modelName = presetFamilies.find((f) => f.id === familyFilter)?.name ?? "Every model";
  /** A filter that is on or off, the look of the snippet chips. */
  const toggle = (on: boolean, set: (on: boolean) => void, label: ReactNode, tip: string) => (
    <button
      type="button"
      aria-pressed={on}
      data-tip={tip}
      onClick={() => set(!on)}
      className={cx("flex h-[26px] shrink-0 items-center rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors", on ? "border-accent bg-accent-wash font-semibold text-ink" : "border-line-strong font-semibold text-ink-2 hover:text-ink")}
    >
      {label}
    </button>
  );
  const groups = [
    ...familyList.map((f) => ({ key: f.id, title: f.name, items: presetsShown.filter((e) => familyOf(e)?.id === f.id) })),
    { key: "any", title: "Any model", items: presetsShown.filter((e) => familyOf(e) === null) },
    { key: "gone", title: "Model no longer here", items: presetsShown.filter((e) => familyOf(e) === undefined) },
  ].filter((g) => g.items.length);
  const presetBadges = (e: Extract<Entity, { kind: "preset" }>) => {
    const st = filesOf(e);
    const missing = missingOf(e);
    return (
      <>
        {e.source === "shipped" && <Badge>{authorOf(e)}</Badge>}
        {missing > 0 ? <Badge tone="warn">{missing} file{missing > 1 ? "s" : ""} missing</Badge> : st && st.files.length > 0 ? <Badge tone="good">files ready</Badge> : null}
      </>
    );
  };
  const presetLine = (e: Extract<Entity, { kind: "preset" }>) => {
    const r = recipeList.find((x) => x.id === e.def.recipe);
    const n = Object.keys(e.def.inputs).length;
    return [e.source === "shipped" ? "" : e.def.author, r?.title, n ? `${n} parameter${n > 1 ? "s" : ""}` : "", e.def.look && (e.def.look.cast.length || e.def.look.style || e.def.look.snippets?.length) ? "with references" : ""].filter(Boolean).join(" · ");
  };
  const presetRow = (e: Extract<Entity, { kind: "preset" }>) => {
    const f = familyOf(e);
    // the group's heading says the model: the row itself carries only a mark for the two odd cases
    return <Row key={e.id} active={open === e.id} onClick={() => select(e.id)} onMenu={(ev) => onMenu(e, ev)} mark={f ? null : <Mark title={f === null ? "Any model" : "Model no longer here"}>{f === null ? "any" : "?"}</Mark>} title={e.name} summary={presetLine(e)} badges={presetBadges(e)} />;
  };
  return (
    <>
      <div role="group" aria-label="Filter the presets" className="flex items-center gap-1.5 overflow-hidden border-b border-line px-4 py-2.5">
        <button
          type="button"
          aria-haspopup="menu"
          aria-label={`Which model: ${modelName}`}
          disabled={presetFamilies.length < 2 && !familyFilter}
          onClick={(e) => modelMenu.open(e, null)}
          className={buttonClass({ size: "sm", className: cx("flex min-w-0 items-center gap-1.5", familyFilter && "border-accent/45 bg-accent-wash") })}
        >
          <span className="truncate">{modelName}</span> <ChevronDown size={13} className="shrink-0" />
        </button>
        {toggle(onlyMine, setOnlyMine, "Mine", "Only the presets you made or imported, not the shipped ones")}
        {toggle(onlyMissing, setOnlyMissing, <>Files missing{missingCount > 0 && <span className="ml-1 tabular-nums text-ink-3">{missingCount}</span>}</>, "Only the presets that need a file this ComfyUI does not have")}
      </div>
      {modelMenu.menu && <ContextMenu at={modelMenu.menu.at} label="Which model" items={modelItems} onClose={modelMenu.close} />}
      <div className="flex min-h-0 grow flex-col gap-1 overflow-y-auto px-3 py-3">
        {children}
        {found.length > 0 && presetsShown.length === 0 && <div className="px-2 py-6 text-center text-xs text-ink-2">No preset matches these filters.</div>}
        {groups.map((g) => (
          <div key={g.key} className="flex flex-col gap-0.5">
            <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">{g.title}</div>
            {g.items.map((e) => presetRow(e as Extract<Entity, { kind: "preset" }>))}
          </div>
        ))}
      </div>
    </>
  );
}
