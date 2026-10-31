import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fileKey } from "@afflatus/core";
import { useState } from "react";
import { api, type ModelDeleteDone, type ModelFile } from "../../api";
import { Dialog, DialogHead } from "../../Dialog";
import { dayOf, plural, size, when } from "../../format";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { useBanners } from "../../store";
import { Button, cx, Help, Segmented } from "../../ui";
import { lastSaid, nameOf } from "./modelFilesView";

/** What a Delete did, said once it is done: with Undo (the whole Delete put back), and what went elsewhere or stayed. */
function sayDone(done: ModelDeleteDone, to: "bin" | "aside", undo: () => void) {
  const push = useBanners.getState().push;
  const where = to === "bin" ? "the Recycle Bin" : "the set-aside folder";
  if (done.moved) push({ id: `model-files:${done.batch}`, tone: "good", title: `${plural(done.moved, "file")} moved to ${where} · ${size(done.bytes)}`, text: "The space comes back once they are emptied (Settings › Model files).", go: "Undo", act: undo });
  if (done.aside.length && to === "bin") push({ id: `model-files:aside:${done.batch}`, tone: "good", title: `${plural(done.aside.length, "file")} went to the set-aside folder instead`, text: done.aside.map((a) => `${a.file}: ${a.why}`).join(" · ") });
  if (done.also.length) push({ id: `model-files:also:${done.batch}`, tone: "good", title: `${plural(done.also.length, "file")} also seen through another folder, moved once`, text: done.also.map((a) => `${a.file}: also seen as ${a.as.join(", ")}`).join(" · ") });
  if (done.left.length) push({ id: `model-files:left:${done.batch}`, tone: "bad", title: `${plural(done.left.length, "file")} left in place`, text: done.left.map((a) => `${a.file}: ${a.why}`).join(" · ") });
}

/**
 * Delete, asked: where the files go (the Recycle Bin, or the set-aside folder beside the model folders), what needs one of
 * them (a preset or a model set: "Keep that one, delete 11"), and the files themselves. Nothing is erased from here.
 */
export function DeleteDialog({ files, all, bin, since, onClose, onDone }: { files: ModelFile[]; all: ModelFile[]; bin: boolean; since: string | null; onClose(): void; onDone(ids: string[]): void }) {
  const client = useQueryClient();
  const [to, setTo] = useState<"bin" | "aside">(bin ? "bin" : "aside");
  const said = useSayFailed({ id: "model-files", href: "/settings/model-files", go: "Open Settings › Model files" });
  // a preset or a set names a file by its name: a copy of it staying in another sub-folder still has what it needs. A row
  // is one file on disk with all its places: the places of one deleted are never a copy that stays
  const placesOf = (f: ModelFile) => [f, ...f.also];
  const staying = new Set(all.filter((f) => !f.removed && !files.includes(f)).flatMap((f) => placesOf(f).map(fileKey)));
  // of a needed file asked twice or more (its copies), one is enough to keep: the one used most
  const needy: ModelFile[] = [];
  for (const f of [...files].sort((a, b) => b.uses - a.uses)) {
    if (placesOf(f).every((p) => staying.has(fileKey(p))) || !f.needs.some((n) => n.kind !== "family") || needy.some((x) => fileKey(x) === fileKey(f))) continue;
    needy.push(f);
  }
  const rest = files.filter((f) => !needy.includes(f));
  const bytes = (fs: ModelFile[]) => fs.reduce((n, f) => n + (f.size ?? 0), 0);
  // a name two of a folder's directories hold is two rows alike: the one asked is told by where it is
  const twice = (f: ModelFile) => all.some((x) => x !== f && !x.removed && x.folder === f.folder && x.file === f.file);
  const now = Date.now();
  const del = useMutation({
    mutationFn: ({ fs, anyway }: { fs: ModelFile[]; anyway: boolean }) => api.deleteModelFiles({ files: fs.map((f) => ({ folder: f.folder, file: f.file, ...(f.path ? { path: f.path } : {}), ...(f.size !== null ? { size: f.size } : {}), ...(f.mtime !== null ? { mtime: f.mtime } : {}) })), to, anyway }),
    onSuccess: (done) => {
      sayDone(done, to, () => void api.putBackModelFiles({ batch: done.batch }).catch(said("Could not put them back")).finally(() => void client.invalidateQueries({ queryKey: queryKeys.modelInfo.all() })));
      onDone(files.map((f) => f.id));
      onClose();
    },
    onError: said("Could not delete them"),
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.modelInfo.all() }),
  });
  const go = (fs: ModelFile[], anyway: boolean) => del.mutate({ fs, anyway });
  return (
    <Dialog label="Delete model files" onClose={onClose} className="flex w-[640px] max-w-[94vw] flex-col gap-4 rounded-card border border-line bg-panel p-5 shadow-lg">
      <DialogHead tone="warn" title={`Delete ${plural(files.length, "model file")} · ${size(bytes(files))}?`} sub="Nothing is erased for good from here: they can be put back." onClose={onClose} />
      {bin && (
        <div className="flex flex-col gap-1.5">
          <Segmented<"bin" | "aside"> size="sm" label="Where they go" value={to} options={[{ value: "bin", label: "To the Recycle Bin" }, { value: "aside", label: "To the set-aside folder" }]} onChange={setTo} className="self-start" />
          <span className="text-body text-ink-2">
            {to === "bin" ? <><b>The space is freed when the Recycle Bin is emptied.</b> Put back from here, or with Windows' Restore.</> : <><b>.afflatus-set-aside</b>, beside the model folders, on the same drive: the space comes back with Empty here.</>}
            <Help text={to === "bin" ? "Windows keeps a bin per drive with a size limit. A file bigger than the bin's room left, or on a drive whose bin is off, goes to the set-aside folder instead: Afflatus never lets Windows erase it, and says so." : "Each file keeps its folder under the set-aside folder (loras/flux/…), so putting it back is a move. ComfyUI does not list it there."} />
          </span>
        </div>
      )}
      {needy.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg border border-attention/40 bg-attention-wash px-3 py-2.5 text-body">
          <span className="font-semibold text-attention-ink">⚠ {needy.length === 1 ? "One of them is" : `${needy.length} of them are`} needed by a preset or a model set</span>
          {needy.map((f) => (
            <span key={f.id}><b>{nameOf(f)}</b> <span className="font-mono text-xs text-ink-3">{f.size === null ? "" : size(f.size)}</span> · {f.needs.filter((n) => n.kind !== "family").map((n) => `${n.kind === "preset" ? "preset" : "model set"} ${n.name}`).join(", ")}</span>
          ))}
          <span className="text-ink-2">Without it, that preset's next render stops at "missing model" and offers to get it again{bytes(needy) ? ` (${size(bytes(needy))} to fetch)` : ""}.</span>
        </div>
      )}
      <div className="flex max-h-[260px] flex-col overflow-y-auto rounded-lg border border-line">
        {files.map((f) => (
          <div key={f.id} className={cx("grid grid-cols-[minmax(0,1fr)_auto_76px] gap-3 border-b border-line/60 px-3 py-1.5 last:border-b-0", needy.includes(f) && "bg-attention-wash/50")}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-xs">{f.folder}/{f.file}</span>
              {f.path && twice(f) && <span className="truncate text-xs text-ink-3" data-tip={f.path}>in {f.path}</span>}
              {f.also.length > 0 && <span className="truncate text-xs text-ink-3" data-tip={f.also.map((a) => `${a.folder}/${a.file}`).join(", ")}>the same file, also seen as {f.also.map((a) => `${a.folder}/${a.file}`).join(", ")}: gone from there too</span>}
            </span>
            <span className="text-xs text-ink-3">{lastSaid(f, since, (iso) => dayOf(iso, now), (iso) => when(iso, now)).text}</span>
            <span className="text-right font-mono text-xs">{f.size === null ? "—" : size(f.size)}</span>
          </div>
        ))}
      </div>
      <span className="text-xs text-ink-3">Agents (MCP) cannot delete model files: it is on their never-list.</span>
      <div className="flex items-center gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <span className="grow" />
        {needy.length > 0
          ? <>
            <Button tone="danger" disabled={del.isPending} onClick={() => go(files, true)}>Delete all {files.length}</Button>
            <Button tone="primary" disabled={del.isPending || !rest.length} onClick={() => go(rest, false)}>Keep {needy.length === 1 ? "that one" : `those ${needy.length}`}, delete {rest.length}</Button>
          </>
          : <Button tone="danger" disabled={del.isPending} onClick={() => go(files, false)}>Delete {plural(files.length, "file")}</Button>}
      </div>
    </Dialog>
  );
}
