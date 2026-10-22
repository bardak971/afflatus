import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import type { Toggle } from "@afflatus/workflows";
import { Button, Checkbox, Chip, cx, fieldClass, Help, SectionTitle } from "../../ui";
import { keyOf, plainLabel, rangeOf, Step } from "./parts";
import type { Mapping } from "./useMapping";
import { plural } from "../../format";

/** Step 2: the switches, the choice of how far it runs, and the widgets the form can show. */
export function ShowPanel({ m }: { m: Mapping }) {
  const { found, filter, setFilter } = m;
  return (
    <section className="flex min-h-0 flex-col gap-2 overflow-y-auto border-r border-line p-5">
      <Step n={2} title="What the form shows" hint="Ticked to begin with: what the workflow's author put forward. Tick a switch or a widget to get a control for it. Everything else stays as it is in the file." />
      {/* held at the top while the lists scroll under it, on the column's ground */}
      <div className="sticky top-0 z-10 shrink-0 bg-ground shadow-[0_0_0_8px_var(--color-ground)]">
        <input data-search
          aria-label="Search switches and widgets"
          placeholder={`Search ${found.toggles.length ? `${found.toggles.length} switches and ` : ""}${found.candidates.length} widgets`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className={cx(fieldClass, "h-9 w-full")}
        />
      </div>
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
  // a name in both lists, or twice in one ("Resolution" of two nodes), says which node it is
  const all = [...authorDiff.add, ...authorDiff.remove].map((c) => plainLabel(c.label));
  const clash = new Set(all.filter((l, i) => all.indexOf(l) !== i));
  const names = (list: Array<{ label: string; target: { node: string } }>) => list.map((c) => (clash.has(plainLabel(c.label)) ? `${plainLabel(c.label)} #${c.target.node}` : plainLabel(c.label))).join(" · ");
  return (
    <div className="flex shrink-0 flex-col gap-1.5 rounded-xl border border-accent/35 bg-panel px-3 py-2 text-xs">
      {authorDiff.add.length > 0 && (
        <div className="flex items-start gap-2">
          <span className="min-w-0 grow pt-1.5"><span className="text-ink-2">Author's front, not on the form:</span> <Help className="align-middle" title="Saved differently" text={EXPLAIN} /> <span className="font-semibold">{names(authorDiff.add)}</span></span>
          {/* quiet like its Remove: the header's Save is the screen's one primary action */}
          <Button size="sm" tone="quiet" onClick={() => followAuthor("add")} className="shrink-0">Add {authorDiff.add.length}</Button>
        </div>
      )}
      {authorDiff.remove.length > 0 && (
        <div className="flex items-start gap-2">
          {/* the ? right after what it explains, once: on the first of the two lines shown */}
          <span className="min-w-0 grow pt-1.5"><span className="text-ink-2">On the form, not the author's:</span> {authorDiff.add.length === 0 && <><Help className="align-middle" title="Saved differently" text={EXPLAIN} /> </>}<span className="font-semibold">{names(authorDiff.remove)}</span></span>
          <Button size="sm" tone="quiet" onClick={() => followAuthor("remove")} className="shrink-0">Remove {authorDiff.remove.length}</Button>
        </div>
      )}
    </div>
  );
}

const EXPLAIN = "The form starts with what the workflow's author put forward: the front of their group nodes, settings they named, value nodes they renamed. This one was saved differently: before Afflatus followed the author, or changed since. On the form, not the author's: ticked by Afflatus before, or by you. Add or Remove does it in one click.";

/** A name field in a quiet row: no frame until hovered or focused. */
const quietName = "-mx-1.5 h-7 min-w-24 grow basis-24 rounded-md border border-transparent bg-transparent px-1.5 font-semibold outline-none hover:border-line-strong focus:border-accent focus:bg-raised";
/** The rows of a list, in one card. */
const card = "flex flex-col rounded-xl border border-line bg-panel [&>*+*]:border-t [&>*+*]:border-line";

/** The file's switches: each can be on the form, under a name of the person's. */
function SwitchList({ m }: { m: Mapping }) {
  const { found, b, switches, nodeList, noteFor } = m;
  if (!found.toggles.length) return null;
  // two switches of one name: each says which node it goes through
  const labelCount = found.toggles.reduce((n, t) => n.set(t.label, (n.get(t.label) ?? 0) + 1), new Map<string, number>());
  const viaOf = (t: Toggle) => { const id = t.effects[0]?.nodes[0]; return id ? nodeList.find((n) => n.id === id)?.title : undefined; };
  return (
    <>
      <div className="flex items-center gap-2 pt-1">
        <SectionTitle>Switches · {b.toggles.filter((t) => !t.made).length} of {found.toggles.length} on the form</SectionTitle>
        <Help title="Switches" text="Parts of the workflow that can be turned off. Ticked, the form gets a switch for it, under a name of yours." />
      </div>
      {!switches.length && <div className="text-ink-2">No switch matches.</div>}
      {switches.length > 0 && <div className={card}>{switches.map((t) => {
        const ticked = b.toggles.find((x) => x.id === t.id);
        const nodes = t.effects.reduce((n, e) => n + e.nodes.length, 0);
        const via = (labelCount.get(t.label) ?? 0) > 1 ? viaOf(t) : undefined;
        const warnings = noteFor(t.label);
        return (
          <div key={t.id} className="flex flex-col gap-1 px-3 py-1.5">
            <div className="flex min-h-7 items-center gap-2.5">
              <Checkbox label={`Add the switch ${t.label}`} checked={Boolean(ticked)} onChange={() => m.toggleSwitch(t)} />
              {/* its name, then its ? right after it */}
              <span className="flex min-w-24 grow basis-24 items-center gap-1.5">
                {ticked ? (
                  <input aria-label="Name of the switch" value={ticked.label} onChange={(e) => m.changeSwitch(t.id, { label: e.target.value })} className={quietName} />
                ) : (
                  <span className="min-w-0 truncate text-ink-2" data-tip={plainLabel(t.label)}>{plainLabel(t.label)}</span>
                )}
                {t.help && <Help text={t.help} />}
              </span>
              <span className="min-w-0 truncate text-xs text-ink-3">{via && <span data-tip="Two switches of this name: this one goes through this node">via {via} · </span>}{t.default ? "on" : "off"} in the file · {plural(nodes, "node")}</span>
            </div>
            {warnings.map((w) => <span key={w} className="flex items-start gap-1.5 text-xs text-warn-ink"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{w}</span>)}
          </div>
        );
      })}</div>}
      <div className="pt-2" />
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
      <div className="flex items-center gap-2">
        <SectionTitle>{hires ? "Hires fix" : "Partial run"}</SectionTitle>
        <Help
          title={hires ? "Hires fix" : "Partial run"}
          text={hires
            ? "This workflow is a base pass, then an upscale and a second sampling pass over the larger latent. Ticked, the form gets a Hires fix switch: off runs the base pass only, and the upscale and second-pass widgets are hidden."
            : `This workflow has a Preview node at ${found.stages.length} points on the way. Ticked, the form gets a "Run" choice (${found.stages.map((st) => st.label).join(" / ")}): what comes after the chosen point is not run.`}
        />
      </div>
      <div className="flex min-h-11 items-center gap-2.5 rounded-xl border border-line bg-panel px-3 py-1.5">
        <Checkbox label={hires ? "Add a Hires fix switch" : "Add a Run choice"} checked={on} onChange={() => set({ stages: on ? [] : found.stages })} />
        <span className={cx("min-w-0 grow", on ? "font-semibold" : "text-ink-2")}>{hires ? "Hires fix" : "Run"}</span>
        <span className="shrink-0 text-xs text-ink-3">{hires ? "a switch · on in the file" : `a choice of ${found.stages.length}`}</span>
      </div>
      <div className="pt-2" />
    </>
  );
}

const WIDGETS = "Every widget of the file, by node, folded until wanted. Ticked, the form gets a control for it, under a name of yours; the rest stays as it is in the file. A \"?\" by a node is its author's own note.";

/** The widgets of each node, folded until wanted (a node with a ticked widget, or a search, opens; a click folds it all the same). */
function WidgetList({ m }: { m: Mapping }) {
  const { found, b, groups, filter, taken } = m;
  // what was opened or folded by hand; a search starts its own, all open
  const [flipped, setFlipped] = useState<Map<string, boolean>>(new Map());
  const [searchFolded, setSearchFolded] = useState<{ q: string; nodes: Set<string> }>({ q: "", nodes: new Set() });
  const folded = searchFolded.q === filter ? searchFolded.nodes : new Set<string>();
  const isOpen = (node: string, ticked: number) => (filter ? !folded.has(node) : flipped.get(node) ?? ticked > 0);
  const flipNode = (node: string, open: boolean) => {
    if (filter) {
      const nodes = new Set(folded);
      if (open) nodes.add(node);
      else nodes.delete(node);
      setSearchFolded({ q: filter, nodes });
    } else setFlipped((old) => new Map(old).set(node, !open));
  };
  return (
    <>
      <div className="flex items-center gap-2">
        <SectionTitle>Widgets · by node · {b.controls.length} on the form</SectionTitle>
        <Help title="Widgets" text={WIDGETS} />
      </div>
      {groups.map(([node, items]) => {
        const tickedHere = items.filter((c) => b.controls.some((x) => x.id === c.id)).length;
        const open = isOpen(node, tickedHere);
        return (
          <div key={node} className="flex flex-col gap-1">
            {/* the node author's "?" sits beside the row's button, not in it: a button cannot hold another */}
            <div className="flex items-center gap-1.5 rounded-md text-xs hover:bg-hover">
              <button type="button" aria-expanded={open} onClick={() => flipNode(node, open)} className="flex min-w-0 items-center gap-1.5 py-1 text-left">
                {open ? <ChevronDown size={13} className="shrink-0 text-ink-3" /> : <ChevronRight size={13} className="shrink-0 text-ink-3" />}
                <span className="min-w-0 truncate font-semibold">{items[0]!.title}</span>
                <span className="shrink-0 text-ink-3">#{node}</span>
              </button>
              {found.about?.[items[0]!.classType] && <Help text={found.about[items[0]!.classType]!} />}
              <button type="button" tabIndex={-1} aria-hidden onClick={() => flipNode(node, open)} className="h-6 grow" />
              <span className="shrink-0 py-1 text-ink-2">{tickedHere ? `${tickedHere} of ${items.length}` : `${plural(items.length, "widget")}`}</span>
            </div>
            {open && <div className={cx(card, "ml-4")}>{items.map((c) => {
              const ticked = b.controls.find((x) => x.id === c.id);
              const used = taken.has(keyOf(c.target));
              return (
                <div key={c.id} className={cx("flex min-h-10 items-center gap-2.5 px-3 py-1.5", used && "opacity-50")}>
                  <Checkbox label={`Add a control for ${c.label}`} checked={Boolean(ticked)} disabled={used} onChange={() => m.toggleControl(c)} />
                  {/* its name, then its ? right after it */}
                  <span className="flex min-w-24 grow basis-24 items-center gap-1.5">
                    {ticked ? (
                      <input aria-label="Name of the control" value={ticked.label} onChange={(e) => m.change(c.id, { label: e.target.value })} className={quietName} />
                    ) : (
                      <span className="min-w-0 truncate text-ink-2" data-tip={plainLabel(c.label)}>{plainLabel(c.label)}</span>
                    )}
                    {c.help && <Help text={c.help} />}
                  </span>
                  <Origin c={c} />
                  {!ticked && (() => {
                    const what = used ? "already in step 1" : `${rangeOf(c)}${c.off ? " · in a part that is off" : ""}`;
                    return <span className="min-w-0 truncate text-xs text-ink-3" data-tip={what}>{what}</span>;
                  })()}
                </div>
              );
            })}</div>}
          </div>
        );
      })}
      {!groups.length && <div className="text-ink-2">{filter ? "No widget matches." : "This workflow has no other widget that can be exposed."}</div>}
    </>
  );
}

/** Who chose a widget: its author put it forward (a group node's front, a name they gave it), or Afflatus ticked it because the author put nothing forward. */
function Origin({ c }: { c: Mapping["found"]["candidates"][number] }) {
  if (c.byAuthor) return <Chip size="xs" tone="accent" tip="The workflow's author put this forward: on the front of a group node, or named by them">author</Chip>;
  if (c.suggested) return <Chip size="xs" tip="The author put nothing forward, so Afflatus ticked the sampler's steps and cfg">Afflatus pick</Chip>;
  return null;
}
