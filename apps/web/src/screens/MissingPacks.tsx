import { useMemo } from "react";
import type { Inspection, Wiring, WorkflowDef } from "@afflatus/workflows";
import { api } from "../api";
import { plural } from "../format";
import { PackInstallActions, PackStateLine, usePackInstall } from "./PackInstall";

const link = "font-semibold text-accent underline underline-offset-2 hover:text-ink";
/** The workflow read again: what was found, with the workflow in the form Afflatus keeps. */
export type Inspected = Inspection & { graph: WorkflowDef["graph"]; wiring?: Wiring };

/**
 * The node types a workflow uses that this ComfyUI lacks, by the pack each comes from, with one button
 * that has ComfyUI-Manager install the packs. The packs come from the workflow (its author's ComfyUI
 * wrote each node's pack) and, for the rest, from Manager's own map; a node type nobody places is
 * listed on its own with a search link. ComfyUI reads custom_nodes at start: a restart follows.
 */
export function MissingPacks({ missing, packs, graph, wiring, editor, onInspected }: {
  missing: string[];
  packs: Record<string, string>;
  graph: WorkflowDef["graph"];
  wiring?: Wiring;
  /** The editor's own file, when the workflow came from one: read again from it, the nodes of the new packs are read by their own fields. */
  editor?: unknown;
  /** Called with the workflow read again once ComfyUI is back after the restart. */
  onInspected(found: Inspected): void;
}) {
  const groups = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const n of missing) {
      const p = packs[n] ?? "";
      if (!by.has(p)) by.set(p, []);
      by.get(p)!.push(n);
    }
    // the known packs first, by name; the orphans last
    return [...by.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [missing, packs]);
  const named = groups.filter(([p]) => p).length;
  const install = usePackInstall({
    missing,
    packs,
    // from the editor's file when there is one: its nodes of the new packs were read without their fields before
    readAgain: async () => onInspected(await api.inspectWorkflow(editor ?? { graph, wiring })),
    again: { what: "the workflow", reopen: "reopen this workflow" },
  });

  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg bg-warn-wash px-3 py-2 text-warn-ink">
      <span>
        Your ComfyUI is missing {plural(missing.length, "node type")} this workflow uses{named ? `, from ${plural(named, "pack")}` : ""}. You can save it, but it cannot run until they are installed.
      </span>
      <ul className="flex flex-col gap-1">
        {groups.map(([pack, nodes]) => (
          <li key={pack || "?"} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {!pack
              ? <span className="font-semibold">No pack known</span>
              : /^https?:/i.test(pack)
                // an address, not a registry id (a workflow saved before this was checked): shown as it is, never as the registry's
                ? <span><span className="font-mono break-all">{pack}</span> <span className="opacity-70">(not from the registry)</span></span>
                : <a className={link} href={`https://registry.comfy.org/nodes/${encodeURIComponent(pack)}`} target="_blank" rel="noreferrer">{pack}</a>}
            <span className="opacity-70">{nodes.join(" · ")}</span>
            {!pack && nodes.map((n) => (
              <a key={n} className={link} href={`https://github.com/search?q=${encodeURIComponent(`"${n}" comfyui`)}&type=code`} target="_blank" rel="noreferrer">search GitHub for {n}</a>
            ))}
            {pack && <PackStateLine s={install.stateOf(pack)} />}
          </li>
        ))}
      </ul>
      {named > 0 && <PackInstallActions install={install} named={named} missingLeft={missing.length > 0} />}
    </div>
  );
}
