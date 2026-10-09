import { useState, type ReactNode } from "react";
import type { Entity } from "../../api";
import { useRecipes } from "../../data";
import { usePresetFiles } from "../../PresetFiles";
import { Segmented } from "../../ui";
import { Badge, Mark, Row } from "./Row";

/** "all", "mine", "missing", or "by:<author>" for the presets shipped under that author's name (none is Afflatus's own: they are called by who made them). */
type PresetFilter = string;
/** The author a shipped preset is filed under when its file names none. */
const UNNAMED_AUTHOR = "Shipped";
/** Who a shipped preset is by, as its file says; a shipped file that names nobody is filed under one word. */
export const authorOf = (e: Entity) => (e.kind === "preset" && e.def.author?.trim()) || UNNAMED_AUTHOR;

/**
 * The presets the search leaves, grouped by the model they are for, with filters for yours, the shipped
 * ones by author, and the ones whose files are missing. Above the rows, what the list's head holds for
 * every kind (the new button, the import).
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
  const [filter, setFilter] = useState<PresetFilter>("all");
  const [familyFilter, setFamilyFilter] = useState<string | null>(null);
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
    && (filter === "all" || (filter === "mine" && !e.source) || (filter.startsWith("by:") && e.source === "shipped" && authorOf(e) === filter.slice(3)) || (filter === "missing" && missingOf(e) > 0))
    && (!familyFilter || familyOf(e)?.id === familyFilter));
  const presetFamilies = familyList.filter((f) => found.some((e) => familyOf(e)?.id === f.id));
  // the chips: the authors of the shipped presets present, each its own; Mine only once there is something that is not the user's
  const authors = [...new Set(found.filter((e): e is Extract<Entity, { kind: "preset" }> => e.kind === "preset" && e.source === "shipped").map(authorOf))].sort();
  const filters: Array<{ id: PresetFilter; label: string }> = [
    { id: "all", label: "All" },
    ...(authors.length ? [{ id: "mine", label: "Mine" }] : []),
    ...authors.map((a) => ({ id: `by:${a}`, label: a })),
    { id: "missing", label: "Files missing" },
  ];
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
      <div className="flex flex-col gap-2 border-b border-line px-4 py-2.5">
        <Segmented size="sm" label="Whose presets" value={filter} options={filters.map((f) => ({ value: f.id, label: f.label }))} onChange={setFilter} />
        {presetFamilies.length > 1 && (
          // "" is every model
          <Segmented size="sm" label="Which model" value={familyFilter ?? ""} options={[{ value: "", label: "Every model" }, ...presetFamilies.map((f) => ({ value: f.id, label: f.name }))]} onChange={(id) => setFamilyFilter(id || null)} />
        )}
      </div>
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
