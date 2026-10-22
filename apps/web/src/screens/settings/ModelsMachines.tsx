import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useSearch } from "wouter";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { api, type Machine, type Scan } from "../../api";
import { useRecipes, useSettings } from "../../data";
import { familyOnFor, machineLabel } from "../../machines";
import { Select } from "../../Select";
import { cx, ErrorNote, Help, Segmented, Toggle } from "../../ui";
import { Block, Card } from "./Rows";
import { ModelsCard } from "./ModelsTab";
import { queryKeys } from "../../queryKeys";
import { COLUMNS } from "./wide";

/** Past this many machines the tabs become a dropdown, as Render times has it. */
const TABS_UP_TO = 4;

/** What a family is on one machine, for a cell of the All grid. */
type Cell = { kind: "away" } | { kind: "off"; found: boolean } | { kind: "on"; good: number; of: number };

/** A family on a machine, from its scan and its switches (familyOnFor): off (with its files there or not), away (no scan), or how many of its operations are ready. */
function cellOf(scan: Scan | undefined, machine: Machine, said: Record<string, boolean>, family: string, recipes: string[], all = false): Cell {
  if (!scan?.comfy.online) return { kind: "away" };
  const good = recipes.filter((id) => scan.recipes.find((r) => r.id === id)?.ready).length;
  return familyOnFor(machine.families ?? {}, said, family, good > 0, all) ? { kind: "on", good, of: recipes.length } : { kind: "off", found: good > 0 };
}

/**
 * Settings › Models with several ComfyUIs: All, every family against every machine, and a tab for each machine (the Models
 * card as that machine has it, its switches, downloads to it). With one ComfyUI, the Models card alone, as before.
 */
export function ModelsByMachine({ left, right }: {
  /** The tab's other cards, under the models in the first column and in the second: the machine picker is above both. */
  left?: ReactNode;
  right?: ReactNode;
}) {
  const settings = useSettings();
  const recipes = useRecipes();
  const machines = settings.data?.machines ?? [];
  const [tab, setTab] = useState("all");
  // a machine asked for in the address (the command bar's "models on second gpu"): its tab opened
  const askedMachine = new URLSearchParams(useSearch()).get("machine");
  useEffect(() => {
    if (askedMachine) setTab(askedMachine);
  }, [askedMachine]);
  const scans = useQueries({ queries: machines.map((m) => ({ queryKey: queryKeys.setup(m.id), queryFn: ({ signal }: { signal: AbortSignal }) => api.setup({ signal }, m.id), staleTime: 60_000, enabled: machines.length > 1 })) });
  // the picker spans the tab, the two columns under it: inside the first, it put the models below the second's top
  const columns = (models: ReactNode) => (
    <div className={COLUMNS}>
      <div className="flex flex-col gap-4">{models}{left}</div>
      <div className="flex flex-col gap-4">{right}</div>
    </div>
  );
  if (machines.length < 2) return columns(<ModelsCard />);
  const said = settings.data?.families ?? {};
  const families = (recipes.data?.families ?? []).filter((f) => recipes.data?.recipes.some((r) => r.family === f.id));
  const recipesOf = (family: string) => (recipes.data?.recipes ?? []).filter((r) => r.family === family).map((r) => r.id);
  // a machine's tab says how many families that are on there miss something
  const missing = (i: number) => families.filter((f) => {
    const c = cellOf(scans[i]?.data, machines[i]!, said, f.id, recipesOf(f.id), settings.data?.allFamilies);
    return c.kind === "on" && c.good < c.of;
  }).length;
  const picked = machines.find((m) => m.id === tab);
  const label = (m: Machine, i: number) => {
    const n = missing(i);
    return n ? `${machineLabel(m)} · ${n}` : machineLabel(m);
  };
  return (
    <>
      <div className="flex items-center gap-3">
        {machines.length <= TABS_UP_TO ? (
          <Segmented oneLine size="sm" label="Which machine" value={tab} onChange={setTab} options={[{ value: "all", label: "All" }, ...machines.map((m, i) => ({ value: m.id, label: label(m, i), tip: missing(i) ? `${machineLabel(m)}: ${missing(i)} of the families on there miss something` : undefined }))]} />
        ) : (
          <div className="w-60 shrink-0">
            <Select size="sm" label="Which machine" value={tab} onChange={setTab} options={[{ value: "all", label: "All machines" }, ...machines.map((m, i) => ({ value: m.id, label: label(m, i) }))]} />
          </div>
        )}
        <Help text="All: every model family against every machine; its switch is the family everywhere. A machine's tab: what that ComfyUI has, its own switches (the queue sends it only the families on there), and downloads go to it." />
      </div>
      {columns(picked ? <ModelsCard key={picked.id} machine={picked} /> : <AllGrid machines={machines} scans={scans.map((q) => q.data)} onOpen={setTab} />)}
    </>
  );
}

/**
 * Every family against every machine: ready, how many of its operations are, off there, or away. A cell opens that machine's
 * tab. The switch is the family on every machine: off, off everywhere (out of the model lists); on, back wherever its files
 * are, a machine's own "off" set by hand dropped too.
 */
function AllGrid({ machines, scans, onOpen }: { machines: Machine[]; scans: Array<Scan | undefined>; onOpen(id: string): void }) {
  const settings = useSettings();
  const recipes = useRecipes();
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: ({ family, on }: { family: string; on: boolean }) => {
      const said = { ...(settings.data?.families ?? {}) };
      if (on) delete said[family];
      else said[family] = false;
      // a machine's own switch that says the opposite goes, so that the family is what this switch says everywhere
      const next = machines.map((m) => {
        const own = { ...(m.families ?? {}) };
        if (own[family] === !on) delete own[family];
        return { ...m, families: own };
      });
      return api.saveSettings({ families: said, machines: next });
    },
    onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved),
  });
  if (!recipes.data || !settings.data) return null;
  const said = settings.data.families;
  const families = recipes.data.families.filter((f) => recipes.data.recipes.some((r) => r.family === f.id));
  const recipesOf = (family: string) => recipes.data.recipes.filter((r) => r.family === family).map((r) => r.id);
  return (
    <Card
      id="models"
      setting="models.families"
      title={<span className="flex items-center gap-1.5">Models <Help title="Models" text="Each model family on each machine: ready, how many of its operations are, off there (switched off, its files there), no files there, or away (not answering). Click a cell for that machine's tab. The switch turns the family off on every machine (out of the model lists), or back on wherever its files are." /></span>}
    >
      {/* one grid, the machines' names its head (on two lines when narrow): each column as wide as the room allows, up to a
          chip's width, the family's name keeping room to be read; past what fits (a narrow window) it scrolls sideways
          rather than cutting the last machines off. The names sat in the card's head before, at a fixed 128 px each: with
          9 machines at 1680 px they ran over the title, hid the families' names and cut the 9th column */}
      <div className="overflow-x-auto px-gutter pb-1">
        <div className="grid items-center gap-x-1" style={{ gridTemplateColumns: `minmax(120px, 1fr) repeat(${machines.length}, minmax(52px, 128px)) 40px` }}>
          <span className="self-end py-1.5 pr-3 text-xs text-ink-3">Family</span>
          {machines.map((m) => <span key={m.id} data-tip={machineLabel(m)} className="line-clamp-2 min-w-0 self-end py-1.5 text-center text-xs leading-tight break-words text-ink-3">{machineLabel(m)}</span>)}
          <span />
          {families.map((f) => {
            const cells = machines.map((m, i) => cellOf(scans[i], m, said, f.id, recipesOf(f.id), settings.data?.allFamilies));
            const on = cells.some((c) => c.kind === "on");
            return (
              <Fragment key={f.id}>
                <span className={cx("flex min-h-[48px] min-w-0 items-center truncate pr-3 font-semibold", !on && "text-ink-2 opacity-70")} data-tip={f.name}>{f.name}</span>
                {cells.map((c, i) => (
                  <button
                    key={machines[i]!.id}
                    type="button"
                    onClick={() => onOpen(machines[i]!.id)}
                    data-tip={`${f.name} on ${machineLabel(machines[i]!)}: open its tab`}
                    className={cx(
                      "h-7 min-w-0 truncate rounded-md px-1 text-center text-xs font-semibold hover:bg-hover",
                      c.kind === "on" ? (c.good === c.of ? "text-good" : "text-warn-ink") : "font-normal text-ink-3",
                      !on && "opacity-70",
                    )}
                  >
                    {c.kind === "away" ? "away" : c.kind === "off" ? (c.found ? "off" : "no files") : c.good === c.of ? "ready" : `${c.good} of ${c.of}`}
                  </button>
                ))}
                <span className={cx("flex justify-end", !on && "opacity-70")}>
                  <Toggle bare on={on} onChange={(next) => save.mutate({ family: f.id, on: next })} label={`${f.name} on every machine`} />
                </span>
              </Fragment>
            );
          })}
        </div>
      </div>
      {save.isError && <Block><ErrorNote>{save.error.message}</ErrorNote></Block>}
    </Card>
  );
}
