import { folderOfFileInput } from "@afflatus/core";
import { fileLabel } from "../../format";
import { GetFile } from "../../GetFile";
import { Select } from "../../Select";
import { Button, cx, SectionTitle } from "../../ui";
import { MissingPacks } from "../MissingPacks";
import { keyOf, link, searchLinks } from "./parts";
import type { Mapping } from "./useMapping";

/** What stands between the workflow and a first render: packs, files, choices this ComfyUI lacks, and the notes of the reading. */
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
  return (
    <div className="mt-3 flex flex-col gap-1.5 text-xs">
      <SectionTitle>Before it can run</SectionTitle>
      {found.missingNodes.length > 0 && <MissingPacks missing={found.missingNodes} packs={found.packs} graph={graph} wiring={m.wiring} editor={m.start.editor} onInspected={m.reread} />}
      {found.missingFiles.map((f) => {
        const now = String(graph[f.node]?.inputs[f.input] ?? f.file);
        const replaced = now !== f.file;
        return (
          <div key={keyOf(f)} className={cx("flex flex-col gap-1.5 rounded-lg px-3 py-2", replaced ? "border border-line text-ink-2" : "bg-warn-wash text-warn-ink")}>
            <span>
              {replaced ? "Replaced: " : "Your ComfyUI does not have "}
              <span className="font-semibold break-all">{fileLabel(f.file)}</span> ({f.label}).
              {!replaced && " Use another file, or download this one:"}
            </span>
            <Select
              size="sm"
              label={`File to use instead of ${fileLabel(f.file)}`}
              placeholder="Replace with…"
              value={replaced ? now : ""}
              onChange={(file) => replaceFile(f, file || f.file)}
              options={[...(replaced ? [{ value: "", label: "Back to the file the workflow names" }] : []), ...f.options.map((o) => ({ value: o, label: fileLabel(o), note: o.split(/[\\/]/).slice(0, -1).join("/") || undefined }))]}
            />
            {!replaced && (
              <span>
                {f.url
                  ? <a className={link} href={f.url} target="_blank" rel="noreferrer">Download it (the URL is in the workflow)</a>
                  : f.source
                    ? (
                      <>
                        {f.source.how === "notes" ? "The author's notes point to " : f.source.how === "creator" ? "The same author has it on Civitai: " : "A standard file, in ComfyUI-Manager's list: "}
                        {f.source.page ? <a className={link} href={f.source.page} target="_blank" rel="noreferrer">{f.source.title}</a> : <span className="font-semibold">{f.source.title}</span>}
                        {f.source.exact ? ", the file itself" : <>, whose file is <span className="font-semibold break-all">{f.source.file}</span>, not this one: take it only if it is the same model</>}
                      </>
                    )
                    : <>Search for it on {searchLinks(f.file).map((l, i) => <span key={l.url}>{i > 0 && " or "}<a className={link} href={l.url} target="_blank" rel="noreferrer">{l.label}</a></span>)}</>}
                . {where(f)}
                <GetFile file={f.file} folder={folderOfFileInput(f.classType, f.input)} url={f.url ?? f.source?.url} civitai={f.source?.civitai} pick={f.source?.civitai ? f.source.file : undefined} hints={hintsFor(f.node)} auto={!f.url && !f.source} />
              </span>
            )}
          </div>
        );
      })}
      {(found.missingChoices ?? []).map((c) => {
        const now = String(graph[c.node]?.inputs[c.input] ?? c.value);
        const replaced = now !== c.value;
        const what = c.input.replace(/_/g, " ");
        return (
          <div key={keyOf(c)} className={cx("flex flex-col gap-1.5 rounded-lg px-3 py-2", replaced ? "border border-line text-ink-2" : "bg-warn-wash text-warn-ink")}>
            <span>
              {replaced ? <>Replaced: <span className="font-semibold">{c.value}</span> by <span className="font-semibold">{now}</span> as {what} ({c.title}).</> : (
                <>Your ComfyUI does not offer <span className="font-semibold">{c.value}</span> as {what} ({c.title} #{c.node}). It comes from a node pack this ComfyUI does not have, and the prompt would be rejected. Use another:</>
              )}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {!replaced && c.nearest && <Button size="sm" tone="primary" onClick={() => replaceFile(c, c.nearest!)}>Use {c.nearest}, the closest match</Button>}
              <div className="min-w-48 grow">
                <Select
                  size="sm"
                  label={`What to use as ${what} instead of ${c.value}`}
                  placeholder="Pick another…"
                  value={replaced ? now : ""}
                  onChange={(v) => replaceFile(c, v || c.value)}
                  options={c.options.map((o) => ({ value: o, label: o }))}
                />
              </div>
            </div>
          </div>
        );
      })}
      {(found.relocated ?? []).map((r) => (
        <div key={keyOf(r)} className="rounded-lg border border-line px-3 py-2 text-ink-2">
          <span className="font-semibold break-all text-ink">{fileLabel(r.file)}</span> is in your ComfyUI in another folder ({r.found.split(/[\\/]/).slice(0, -1).join("/") || "the top one"}): it is used from there.
        </div>
      ))}
      {found.missingFiles.length > 0 && found.links.length > 0 && (
        <details className="rounded-lg border border-line px-3 py-2 text-ink-2">
          <summary className="cursor-pointer">Links the workflow's author left in its notes ({found.links.length})</summary>
          <div className="flex flex-col gap-1 pt-2">
            {found.links.map((l) => <a key={l.url} className={cx(link, "font-normal break-words")} href={l.url} target="_blank" rel="noreferrer">{l.label}</a>)}
          </div>
        </details>
      )}
      {(found.replaced ?? []).length > 0 && (
        <span className="text-ink-2">
          {found.replaced.map((x) => `${x.from}${found.packs[x.from] ? ` (${found.packs[x.from]})` : ""} #${x.node}`).join(", ")} {found.replaced.length === 1 ? "is" : "are"} not in this ComfyUI: ComfyUI's own {found.replaced.map((x) => x.to).filter((v, i, a) => a.indexOf(v) === i).join(" and ")} stands in{found.replaced.some((x) => /^Save/.test(x.to)) ? ". Afflatus saves and names what it keeps itself" : ", with the same value"}.
        </span>
      )}
      {(found.missingUnneeded ?? []).length > 0 && (
        <span className="text-ink-2">
          Not needed for the result, left out at render: {found.missingUnneeded.map((n) => (found.packs[n] ? `${n} (${found.packs[n]})` : n)).join(", ")}. A preview or a sound when done, mostly; the pack is not asked for.
        </span>
      )}
      {found.missingWhenOn.length > 0 && (
        <span className="text-ink-2">
          Bypassed parts use node types your ComfyUI does not have: {found.missingWhenOn.map((n) => (found.packs[n] ? `${n} (pack ${found.packs[n]})` : n)).join(", ")}. Those switches will not work until they are installed.
        </span>
      )}
      {looseNotes.map((n) => <div key={n} className="rounded-lg bg-warn-wash px-3 py-2 text-warn-ink">{n}</div>)}
    </div>
  );
}
