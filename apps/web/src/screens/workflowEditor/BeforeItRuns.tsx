import { ChevronRight } from "lucide-react";
import { folderOfFileInput } from "@afflatus/core";
import { fileLabel } from "../../format";
import { Select } from "../../Select";
import { Button, cx, Help } from "../../ui";
import { MissingPacks } from "../MissingPacks";
import { MissingFile } from "./MissingFile";
import { keyOf, link } from "./parts";
import type { Mapping } from "./useMapping";

/**
 * What still stands before a first render, by name: the missing node types (one item, the packs), the files and
 * choices not replaced yet, and the notes of the reading. The header's verdict and this card's head count them.
 */
export function beforeItems(m: Mapping): string[] {
  const { found, graph, looseNotes } = m;
  return [
    ...(found.missingNodes.length ? [`${found.missingNodes.length} node type${found.missingNodes.length === 1 ? "" : "s"}: ${found.missingNodes.join(", ")}`] : []),
    ...found.missingFiles.filter((f) => String(graph[f.node]?.inputs[f.input] ?? f.file) === f.file).map((f) => fileLabel(f.file)),
    ...(found.missingChoices ?? []).filter((c) => String(graph[c.node]?.inputs[c.input] ?? c.value) === c.value).map((c) => `${c.value} (${c.input.replace(/_/g, " ")})`),
    ...looseNotes,
  ];
}

/** What stands between the workflow and a first render: packs, files, choices this ComfyUI lacks, and the notes of the reading. At the top of step 1. */
export function BeforeItRuns({ m }: { m: Mapping }) {
  const { found, graph, model, looseNotes, replaceFile } = m;
  /** What says which model a missing file is for: its loader's "type", and the model the workflow is for. */
  const hintsFor = (node: string) => [graph[node]?.inputs.type, model].filter((x): x is string => typeof x === "string" && x.trim().length > 2 && x !== "default");
  /** Where ComfyUI looks for a file that is missing, and where else it has one of that name. */
  const where = (f: { file: string; classType: string; input: string }) => {
    const folder = folderOfFileInput(f.classType, f.input);
    const others = ((found as { elsewhere?: Record<string, string[]> }).elsewhere?.[f.file] ?? []).filter((x) => x !== folder);
    if (others.length) {
      return `ComfyUI has a file of this name in its "${others.join('", "')}" folder, but this loader only looks in "${folder ?? "its own folder"}". Move the file there, or tell ComfyUI that the folder also holds that kind of model (its extra_model_paths.yaml), then restart ComfyUI.`;
    }
    return folder ? `This loader only looks in ComfyUI's "models/${folder}" folders: put the file there, then test again in Settings.` : "It goes in ComfyUI's models folder; then test again in Settings.";
  };
  if (!(found.missingNodes.length > 0 || (found.replaced ?? []).length > 0 || (found.missingUnneeded ?? []).length > 0 || found.missingFiles.length > 0 || (found.missingChoices ?? []).length > 0 || (found.relocated ?? []).length > 0 || found.missingWhenOn.length > 0 || looseNotes.length > 0)) return null;
  const n = beforeItems(m).length;
  return (
    <div data-jump="before" className={cx("flex shrink-0 scroll-mt-3 flex-col rounded-xl border text-xs [&>*:nth-child(n+3)]:border-t [&>*:nth-child(n+3)]:border-line", n ? "border-warn/40 bg-warn/5" : "border-line bg-panel")}>
      <div className={cx("px-3 pt-2.5 pb-1 text-[11px] font-bold tracking-[0.08em] uppercase", n ? "text-warn-ink" : "text-ink-2")}>Before it can run{n ? ` · ${n}` : ""}</div>
      {found.missingNodes.length > 0 && <div className="px-3 py-2"><MissingPacks missing={found.missingNodes} packs={found.packs} graph={graph} wiring={m.wiring} editor={m.start.editor} onInspected={m.reread} /></div>}
      {found.missingFiles.map((f) => <MissingFile key={keyOf(f)} f={f} m={m} hints={hintsFor(f.node)} where={where(f)} />)}
      {(found.missingChoices ?? []).map((c) => {
        const now = String(graph[c.node]?.inputs[c.input] ?? c.value);
        const replaced = now !== c.value;
        const what = c.input.replace(/_/g, " ");
        return (
          <div key={keyOf(c)} className="flex flex-col gap-1.5 px-3 py-2.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cx("min-w-0 truncate font-mono text-[11.5px] font-semibold", replaced && "text-ink-3 line-through")} data-tip={c.value}>{c.value}</span>
              <span className="shrink-0 text-ink-3">{replaced ? `replaced by ${now}` : `${what} · ${c.title} #${c.node}`}</span>
              <Help
                title={c.value}
                text={replaced
                  ? `Replaced: ${c.value} by ${now} as ${what} (${c.title}).`
                  : `Your ComfyUI does not offer ${c.value} as ${what} (${c.title} #${c.node}). It comes from a node pack this ComfyUI does not have, and the prompt would be rejected. Use another.`}
              />
            </span>
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="min-w-0 grow">
                <Select
                  size="sm"
                  label={`What to use as ${what} instead of ${c.value}`}
                  placeholder="Pick another…"
                  value={replaced ? now : ""}
                  onChange={(v) => replaceFile(c, v || c.value)}
                  options={c.options.map((o) => ({ value: o, label: o }))}
                />
              </div>
              {!replaced && c.nearest && <Button size="sm" tone="primary" className="shrink-0" data-tip={`${c.nearest} is the closest match`} onClick={() => replaceFile(c, c.nearest!)}>Use {c.nearest}</Button>}
            </div>
          </div>
        );
      })}
      {(found.relocated ?? []).map((r) => (
        <div key={keyOf(r)} className="px-3 py-2 text-ink-2">
          <span className="font-mono font-semibold break-all text-ink">{fileLabel(r.file)}</span> is in your ComfyUI in another folder ({r.found.split(/[\\/]/).slice(0, -1).join("/") || "the top one"}): it is used from there.
        </div>
      ))}
      {found.missingFiles.length > 0 && found.links.length > 0 && (
        <details className="group px-3 py-2 text-ink-2">
          <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-ink [&::-webkit-details-marker]:hidden">
            <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
            Links in the author's notes · {found.links.length}
          </summary>
          <div className="flex flex-col gap-1 pt-2">
            {found.links.map((l) => <a key={l.url} className={cx(link, "font-normal break-words")} href={l.url} target="_blank" rel="noreferrer">{l.label}</a>)}
          </div>
        </details>
      )}
      {(found.replaced ?? []).length > 0 && (
        <span className="px-3 py-2 text-ink-2">
          {found.replaced.map((x) => `${x.from}${found.packs[x.from] ? ` (${found.packs[x.from]})` : ""} #${x.node}`).join(", ")} {found.replaced.length === 1 ? "is" : "are"} not in this ComfyUI: ComfyUI's own {found.replaced.map((x) => x.to).filter((v, i, a) => a.indexOf(v) === i).join(" and ")} stands in{found.replaced.some((x) => /^Save/.test(x.to)) ? ". Afflatus saves and names what it keeps itself" : ", with the same value"}.
        </span>
      )}
      {(found.missingUnneeded ?? []).length > 0 && (
        <span className="px-3 py-2 text-ink-2">
          Not needed for the result, left out at render: {found.missingUnneeded.map((n) => (found.packs[n] ? `${n} (${found.packs[n]})` : n)).join(", ")}. A preview or a sound when done, mostly; the pack is not asked for.
        </span>
      )}
      {found.missingWhenOn.length > 0 && (
        <span className="px-3 py-2 text-ink-2">
          Bypassed parts use node types your ComfyUI does not have: {found.missingWhenOn.map((n) => (found.packs[n] ? `${n} (pack ${found.packs[n]})` : n)).join(", ")}. Those switches will not work until they are installed.
        </span>
      )}
      {looseNotes.map((n) => <div key={n} className="px-3 py-2 text-warn-ink">{n}</div>)}
    </div>
  );
}
