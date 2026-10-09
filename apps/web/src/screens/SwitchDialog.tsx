import { useMemo, useState } from "react";
import type { Section, Toggle } from "@afflatus/workflows";
import { fuzzyScore } from "@afflatus/core";
import { Dialog } from "../Dialog";
import { Button, Checkbox, cx, Segmented } from "../ui";

/**
 * Making a section's switch: a name, whether it starts on, and the nodes that are bypassed while it is
 * off. The frames the author drew are offered first, with what each holds; nodes one by one on request.
 * A switch may take anything, the output node included: Afflatus says what that means and offers to
 * leave the output out, nothing more.
 */
export function SwitchDialog({ section, existing, frames, nodes, resultNode, onClose, onSave, onRemove }: {
  section: Section;
  existing?: Toggle;
  frames: Array<{ title: string; nodes: string[] }>;
  nodes: Array<{ id: string; title: string; classType: string }>;
  resultNode: string;
  onClose(): void;
  onSave(toggle: Toggle): void;
  /** Take the switch off the section: what saving with no node chosen means for one that exists. */
  onRemove?(): void;
}) {
  const [label, setLabel] = useState(existing?.label ?? "");
  const [on, setOn] = useState(existing?.default ?? true);
  const [chosen, setChosen] = useState<Set<string>>(new Set(existing?.effects.flatMap((e) => e.nodes) ?? []));
  const [oneByOne, setOneByOne] = useState(false);
  const [q, setQ] = useState("");
  const titleOf = (id: string) => nodes.find((n) => n.id === id)?.title ?? `#${id}`;
  const known = new Set(nodes.map((n) => n.id));
  const usable = frames.map((f) => ({ ...f, nodes: f.nodes.filter((id) => known.has(id)) })).filter((f) => f.nodes.length);
  const frameOn = (f: { nodes: string[] }) => f.nodes.every((id) => chosen.has(id));
  const setFrame = (f: { nodes: string[] }, want: boolean) =>
    setChosen((old) => {
      const next = new Set(old);
      for (const id of f.nodes) if (want) next.add(id); else next.delete(id);
      return next;
    });
  const setNode = (id: string, want: boolean) =>
    setChosen((old) => {
      const next = new Set(old);
      if (want) next.add(id); else next.delete(id);
      return next;
    });
  const listed = useMemo(() => nodes.filter((n) => !q || fuzzyScore(q, `${n.title} ${n.classType} ${n.id}`) !== null), [nodes, q]);
  const cutsOutput = chosen.has(resultNode);
  const save = () =>
    onSave({
      id: existing?.id ?? `sw_made_${Date.now().toString(36)}`,
      label: label.trim() || "Switch",
      default: on,
      effects: [{ nodes: [...chosen], activeWhen: true, mode: "skip" }],
      writes: [],
      front: true,
      made: true,
    });

  return (
    <Dialog label={`Switch for ${section.label}`} onClose={onClose} className="flex max-h-[calc(100vh-48px)] w-[560px] max-w-[calc(100vw-32px)] flex-col gap-4 rounded-xl border border-line bg-panel p-5 shadow-xl">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold">{existing ? `The switch “${existing.label}”` : `A switch in “${section.label}”`}</h2>
        <span className="text-xs text-ink-2">On, it shows the settings you drag under it. Off, those fold away and the nodes below are stepped over as one: what fed the part flows through to what read it.</span>
      </div>
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-2">
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Hires fix, Face detailer, 4K pass…" className="h-9 rounded-lg border border-line bg-ground px-3 text-sm font-normal text-ink" />
        </label>
        <div className="flex flex-col gap-1 text-xs font-semibold text-ink-2">
          Starts
          <Segmented<"on" | "off"> label="Starts on or off" value={on ? "on" : "off"} options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]} onChange={(v) => setOn(v === "on")} />
        </div>
      </div>

      {/* the frames and nodes scroll: a workflow can have dozens, and the buttons below stay in sight */}
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1">
        <span className="text-xs font-semibold text-ink-2">When it is off, bypass</span>
        {usable.length > 0 && <span className="text-xs text-ink-2">The frames the author drew around nodes, with what is inside them.</span>}
        {usable.map((f, i) => (
          <label key={i} className={cx("flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-1.5", frameOn(f) ? "border-accent/50 bg-accent-wash" : "border-line bg-ground")}>
            <Checkbox checked={frameOn(f)} onChange={(v) => setFrame(f, v)} />
            <span className="flex min-w-0 flex-col">
              <span className="font-semibold">{f.title}</span>
              <span className="truncate text-xs text-ink-2">frame · {f.nodes.length} node{f.nodes.length === 1 ? "" : "s"} · {f.nodes.slice(0, 4).map(titleOf).join(", ")}{f.nodes.length > 4 ? "…" : ""}{f.nodes.includes(resultNode) ? " · holds the output" : ""}</span>
            </span>
          </label>
        ))}
        {!usable.length && <span className="text-xs text-ink-2">This workflow has no frames: pick the nodes one by one.</span>}
        <button type="button" onClick={() => setOneByOne((v) => !v)} className="self-start text-xs font-semibold text-accent hover:underline">{oneByOne ? "Hide the nodes" : "Pick nodes one by one…"}</button>
        {oneByOne && (
          <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-ground p-1.5">
            <input placeholder={`Search ${nodes.length} nodes`} value={q} onChange={(e) => setQ(e.target.value)} className="h-8 rounded-md border border-line bg-panel px-2 text-xs" />
            {listed.map((n) => (
              <label key={n.id} className="flex h-7 cursor-pointer items-center gap-2 rounded px-1.5 text-xs hover:bg-hover">
                <Checkbox checked={chosen.has(n.id)} onChange={(v) => setNode(n.id, v)} />
                <span className="min-w-0 grow truncate font-semibold">{n.title}</span>
                <span className="shrink-0 text-ink-3">#{n.id}{n.id === resultNode ? " · output" : ""}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-2">{chosen.size ? `${chosen.size} node${chosen.size === 1 ? "" : "s"} chosen.` : existing ? "No node chosen: saving removes the switch." : "Pick a frame or a node: a switch that bypasses nothing changes nothing."}</span>
      </div>

      {cutsOutput && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-warn-wash px-3 py-2 text-xs text-warn-ink">
          <span>The output node, {titleOf(resultNode)}, is among them: off, nothing is saved. That is what the workflow does with those nodes off; it is yours to keep.</span>
          <Button size="sm" onClick={() => setNode(resultNode, false)}>Leave the output out of the switch</Button>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        {existing && !chosen.size
          ? <Button tone="danger" onClick={onRemove}>Remove the switch</Button>
          : <Button tone="primary" onClick={save} disabled={!chosen.size || !label.trim()}>{existing ? "Save the switch" : "Make the switch"}</Button>}
      </div>
    </Dialog>
  );
}
