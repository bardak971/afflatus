import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import type { Toggle } from "@afflatus/workflows";
import { cx, Help, SectionTitle } from "../../ui";
import { keyOf, rangeOf, Step, text } from "./parts";
import type { Mapping } from "./useMapping";

/** Step 2: the switches, the choice of how far it runs, and the widgets the form can show. */
export function ShowPanel({ m }: { m: Mapping }) {
  const { found, filter, setFilter } = m;
  return (
    <section className="flex min-h-0 flex-col gap-2 overflow-y-auto border-r border-line p-5">
      <Step n={2} title="What the form shows" hint="Ticked to begin with: what the workflow's author put forward. Tick a switch or a widget to get a control for it. Everything else stays as it is in the file." />
      <input data-search
        aria-label="Search switches and widgets"
        placeholder={`Search ${found.toggles.length ? `${found.toggles.length} switches and ` : ""}${found.candidates.length} widgets`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className={cx(text, "sticky top-0 z-10 h-9 shrink-0 shadow-[0_0_0_8px_var(--color-ground)]")}
      />
      <FollowAuthor m={m} />
      <SwitchList m={m} />
      <StagesPick m={m} />
      <WidgetList m={m} />
    </section>
  );
}

/**
 * A saved workflow whose form is not what its author put forward (saved before Afflatus followed the author, or
 * changed since): what to add, what to take off, each said by name and done with one click.
 */
function FollowAuthor({ m }: { m: Mapping }) {
  const { start, authorDiff, followAuthor } = m;
  if (!start.id || (!authorDiff.add.length && !authorDiff.remove.length)) return null;
  const names = (labels: string[]) => labels.slice(0, 6).join(", ") + (labels.length > 6 ? ` and ${labels.length - 6} more` : "");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent-wash px-3 py-2.5 text-xs">
      <span className="font-semibold text-ink">The form starts with what the workflow's author put forward. This one was saved differently:</span>
      {authorDiff.add.length > 0 && (
        <div className="flex items-start gap-2">
          <span className="grow text-ink-2">Put forward by the author, not on the form: {names(authorDiff.add.map((c) => c.label))}</span>
          <button type="button" onClick={() => followAuthor("add")} className="shrink-0 rounded-md border border-accent/50 px-2 py-1 font-semibold text-accent hover:bg-hover">Add {authorDiff.add.length}</button>
        </div>
      )}
      {authorDiff.remove.length > 0 && (
        <div className="flex items-start gap-2">
          <span className="grow text-ink-2">On the form, not put forward by the author (ticked by Afflatus before, or by you): {names(authorDiff.remove.map((c) => c.label))}</span>
          <button type="button" onClick={() => followAuthor("remove")} className="shrink-0 rounded-md border border-line px-2 py-1 font-semibold text-ink-2 hover:bg-hover">Remove {authorDiff.remove.length}</button>
        </div>
      )}
    </div>
  );
}

/** The file's switches: each can be on the form, under a name of the person's. */
function SwitchList({ m }: { m: Mapping }) {
  const { found, b, switches, nodeList, noteFor } = m;
  if (!found.toggles.length) return null;
  // two switches of one name: each says which node it goes through
  const labelCount = found.toggles.reduce((n, t) => n.set(t.label, (n.get(t.label) ?? 0) + 1), new Map<string, number>());
  const viaOf = (t: Toggle) => { const id = t.effects[0]?.nodes[0]; return id ? nodeList.find((n) => n.id === id)?.title : undefined; };
  return (
    <>
      <div className="flex items-baseline gap-2 pt-1">
        <SectionTitle>Switches</SectionTitle>
        <span className="text-xs text-ink-2">parts of the workflow that can be turned off · {b.toggles.filter((t) => !t.made).length} of {found.toggles.length} in the form</span>
      </div>
      {!switches.length && <div className="text-ink-2">No switch matches.</div>}
      {switches.map((t) => {
        const ticked = b.toggles.find((x) => x.id === t.id);
        const nodes = t.effects.reduce((n, e) => n + e.nodes.length, 0);
        const via = (labelCount.get(t.label) ?? 0) > 1 ? viaOf(t) : undefined;
        const warnings = noteFor(t.label);
        return (
          <div key={t.id} className={cx("flex flex-col gap-1 rounded-lg border px-3 py-2", ticked ? "border-accent/50 bg-accent-wash" : "border-line bg-panel")}>
            <div className="flex items-center gap-2.5">
              <input type="checkbox" aria-label={`Add the switch ${t.label}`} checked={Boolean(ticked)} onChange={() => m.toggleSwitch(t)} className="accent-accent" />
              {t.help && <Help text={t.help} />}
              {ticked ? (
                <input aria-label="Name of the switch" value={ticked.label} onChange={(e) => m.changeSwitch(t.id, { label: e.target.value })} className="h-7 min-w-0 grow rounded-md border border-line bg-raised px-2 font-semibold" />
              ) : (
                <span className="min-w-0 grow truncate font-semibold">{t.label}</span>
              )}
              <span className="shrink-0 text-xs text-ink-2">{via && <span title="Two switches of this name: this one goes through this node">via {via} · </span>}{t.default ? "on" : "off"} in the file · {nodes} node{nodes === 1 ? "" : "s"}</span>
            </div>
            {warnings.map((w) => <span key={w} className="flex items-start gap-1.5 text-xs text-warn-ink"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{w}</span>)}
          </div>
        );
      })}
      <div className="pt-3" />
    </>
  );
}

/** A workflow with a preview on the way can stop there: hires fix as a switch when that is what its second half is. */
function StagesPick({ m }: { m: Mapping }) {
  const { found, b, set } = m;
  if (!((found.stages?.length ?? 0) > 1 && found.stages.at(-1)!.node === b.result.node)) return null;
  const hires = found.stages.length === 2 && found.stages[0]!.label === "Hires fix off";
  const on = (b.stages?.length ?? 0) > 1;
  return (
    <>
      <SectionTitle>{hires ? "Hires fix" : "Partial run"}</SectionTitle>
      <div className={cx("flex items-center gap-2.5 rounded-lg border px-3 py-2", on ? "border-accent/50 bg-accent-wash" : "border-line bg-panel")}>
        <input type="checkbox" aria-label={hires ? "Add a Hires fix switch" : "Add a Run choice"} checked={on} onChange={() => set({ stages: on ? [] : found.stages })} className="accent-accent" />
        <span className="min-w-0 grow font-semibold">{hires ? "Hires fix" : "Run"}</span>
        <span className="shrink-0 text-xs text-ink-2">{hires ? "a switch · on in the file" : `a choice of ${found.stages.length}`}</span>
      </div>
      <div className="text-xs text-ink-2">
        {hires
          ? "This workflow is a base pass, then an upscale and a second sampling pass over the larger latent. Ticked, the form gets a Hires fix switch: off runs the base pass only, and the upscale and second-pass widgets are hidden."
          : `This workflow has a Preview node at ${found.stages.length} points on the way. Ticked, the form gets a "Run" choice (${found.stages.map((st) => st.label).join(" / ")}): what comes after the chosen point is not run.`}
      </div>
      <div className="pt-3" />
    </>
  );
}

/** The widgets of each node, folded until wanted (a node with a ticked widget, or a search, is open). */
function WidgetList({ m }: { m: Mapping }) {
  const { found, b, groups, filter, taken } = m;
  const [openNodes, setOpenNodes] = useState<Set<string>>(new Set());
  const flipNode = (node: string) => setOpenNodes((old) => { const n = new Set(old); if (n.has(node)) n.delete(node); else n.add(node); return n; });
  return (
    <>
      <div className="flex items-baseline gap-2">
        <SectionTitle>Widgets</SectionTitle>
        <span className="text-xs text-ink-2">by node · {b.controls.length} in the form · a "?" is the node author's own note</span>
      </div>
      {groups.map(([node, items]) => {
        const tickedHere = items.filter((c) => b.controls.some((x) => x.id === c.id)).length;
        const open = Boolean(filter) || openNodes.has(node) || tickedHere > 0;
        return (
          <div key={node} className="flex flex-col gap-1">
            {/* the node author's "?" sits beside the row's button, not in it: a button cannot hold another */}
            <div className="flex items-center gap-1.5 rounded-md text-xs hover:bg-hover">
              <button type="button" aria-expanded={open} onClick={() => flipNode(node)} className="flex min-w-0 items-center gap-1.5 py-1 text-left">
                {open ? <ChevronDown size={13} className="shrink-0 text-ink-3" /> : <ChevronRight size={13} className="shrink-0 text-ink-3" />}
                <span className="min-w-0 truncate font-semibold">{items[0]!.title}</span>
                <span className="shrink-0 text-ink-3">#{node}</span>
              </button>
              {found.about?.[items[0]!.classType] && <Help text={found.about[items[0]!.classType]!} />}
              <button type="button" tabIndex={-1} aria-hidden onClick={() => flipNode(node)} className="h-6 grow" />
              <span className="shrink-0 py-1 text-ink-2">{tickedHere ? `${tickedHere} of ${items.length}` : `${items.length} widget${items.length === 1 ? "" : "s"}`}</span>
            </div>
            {open && items.map((c) => {
              const ticked = b.controls.find((x) => x.id === c.id);
              const used = taken.has(keyOf(c.target));
              return (
                <div key={c.id} className={cx("ml-4 flex items-center gap-2.5 rounded-lg border px-3 py-2", ticked ? "border-accent/50 bg-accent-wash" : "border-line bg-panel", used && "opacity-50")}>
                  <input type="checkbox" aria-label={`Add a control for ${c.label}`} checked={Boolean(ticked)} disabled={used} onChange={() => m.toggleControl(c)} className="accent-accent" />
                  {c.help && <Help text={c.help} />}
                  {ticked ? (
                    <input aria-label="Name of the control" value={ticked.label} onChange={(e) => m.change(c.id, { label: e.target.value })} className="h-7 min-w-0 grow rounded-md border border-line bg-raised px-2 font-semibold" />
                  ) : (
                    <span className="min-w-0 grow truncate font-semibold">{c.label}</span>
                  )}
                  <Origin c={c} />
                  {!ticked && <span className="shrink-0 text-xs text-ink-2">{used ? "already in step 1" : `${rangeOf(c)}${c.off ? " · in a part that is off" : ""}`}</span>}
                </div>
              );
            })}
          </div>
        );
      })}
      {!groups.length && <div className="text-ink-2">{filter ? "No widget matches." : "This workflow has no other widget that can be exposed."}</div>}
    </>
  );
}

/** Who chose a widget: its author put it forward (a group node's front, a name they gave it), or Afflatus ticked it because the author put nothing forward. */
function Origin({ c }: { c: Mapping["found"]["candidates"][number] }) {
  if (c.byAuthor) return <span title="The workflow's author put this forward: on the front of a group node, or named by them" className="shrink-0 rounded-full border border-accent/40 px-1.5 text-[11px] font-semibold text-accent">author</span>;
  if (c.suggested) return <span title="The author put nothing forward, so Afflatus ticked the sampler's steps and cfg" className="shrink-0 rounded-full border border-line px-1.5 text-[11px] font-semibold text-ink-2">Afflatus pick</span>;
  return null;
}
