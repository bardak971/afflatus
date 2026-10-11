import { useMemo, useState } from "react";
import type { Section, Toggle } from "@afflatus/workflows";
import { fuzzyScore } from "@afflatus/core";
import { ToggleRight } from "lucide-react";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "../Dialog";
import { Keys } from "../Keys";
import { Button, Checkbox, cx, fieldClass, Help, Segmented } from "../ui";
import { plural } from "../format";

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

  const ready = chosen.size > 0 && label.trim() !== "";

  return (
    <Dialog label={`Switch for ${section.label}`} onClose={onClose} className={cx(DIALOG.replace("max-w-md", "max-w-[560px]"), "max-h-[calc(100vh-48px)]")}>
      <DialogHead
        icon={<ToggleRight size={16} />}
        title={existing ? `Switch “${existing.label}”` : "New switch"}
        sub={
          <span className="inline-flex items-center gap-1.5">
            in “{section.label}”
            <Help text="On, it shows the settings you drag under it. Off, those fold away and the nodes it bypasses are stepped over as one: what fed the part flows through to what read it." />
          </span>
        }
        onClose={onClose}
      />
      {/* Enter saves, from any box of it; Escape closes (the Dialog's) */}
      <form
        className="flex min-h-0 flex-1 flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) save();
        }}
      >
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink-2">
            Label
            <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Hires fix, Face detailer, 4K pass…" className={cx(fieldClass, "h-9 text-sm font-normal")} />
          </label>
          <div className="flex flex-col gap-1 text-xs font-semibold text-ink-2">
            Starts
            <Segmented<"on" | "off"> label="Starts on or off" value={on ? "on" : "off"} options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]} onChange={(v) => setOn(v === "on")} />
          </div>
        </div>

        {/* the frames and nodes scroll: a workflow can have dozens, and the buttons below stay in sight */}
        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
            Bypassed while off
            <Help text="The frames the author drew around nodes, with what is inside them; or nodes one by one." />
          </span>
          {usable.map((f, i) => (
            <label key={i} className={cx("flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-1.5", frameOn(f) ? "border-accent/50 bg-accent-wash" : "border-line bg-ground")}>
              <Checkbox checked={frameOn(f)} onChange={(v) => setFrame(f, v)} />
              <span className="flex min-w-0 flex-col">
                <span className="font-semibold">{f.title}</span>
                <span className="truncate text-xs text-ink-2">frame · {plural(f.nodes.length, "node")} · {f.nodes.slice(0, 4).map(titleOf).join(", ")}{f.nodes.length > 4 ? "…" : ""}{f.nodes.includes(resultNode) ? " · holds the output" : ""}</span>
              </span>
            </label>
          ))}
          {!usable.length && <span className="text-xs text-ink-3">no frames in this workflow</span>}
          <Button size="sm" tone="quiet" aria-expanded={oneByOne} onClick={() => setOneByOne((v) => !v)} className="self-start">{oneByOne ? "Hide the nodes" : "Pick nodes one by one"}</Button>
          {oneByOne && (
            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-2xl border border-line bg-ground p-1.5">
              {/* Enter here finds, it does not save */}
              <input aria-label="Search the nodes" placeholder={`Search ${nodes.length} nodes`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} className={cx(fieldClass, "h-8 shrink-0 px-2 text-xs")} />
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

        {cutsOutput && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-wash px-3 py-2 text-xs text-warn-ink">
            <span className="flex min-w-0 grow items-center gap-1.5">
              Holds the output node, {titleOf(resultNode)}: off, nothing is saved
              <Help text="That is what the workflow does with those nodes off; it is yours to keep." />
            </span>
            <Button size="sm" onClick={() => setNode(resultNode, false)}>Leave the output out</Button>
          </div>
        )}

        <DialogFoot info={chosen.size ? `${plural(chosen.size, "node")} bypassed while off` : existing ? "no node: saving removes the switch" : "no node chosen"}>
          <Button tone="quiet" onClick={onClose}>Cancel <Keys keys="Esc" size="sm" /></Button>
          {existing && !chosen.size
            ? <Button tone="danger" onClick={onRemove}>Remove the switch</Button>
            : <Button type="submit" tone="primary" disabled={!ready}>{existing ? "Save the switch" : "Make the switch"} <Keys keys="Enter" size="sm" /></Button>}
        </DialogFoot>
      </form>
    </Dialog>
  );
}
