import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { api, type UpdateRow } from "../../api";
import { useModelUpdates, useSettings } from "../../data";
import { dateTime, dayOf, fileLabel } from "../../format";
import { Dialog, DialogHead, DIALOG } from "../../Dialog";
import { Button, cx, ErrorNote, Segmented, Toggle } from "../../ui";
import { Block, Card, Row } from "./Rows";

/** Newer versions of the models here, on Civitai: a check on request, and once a day when asked for. Its own card, wide: the list can be long. */
export function UpdatesCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const report = useModelUpdates();
  const [q, setQ] = useState("");
  // the list in a dialog of its own: few update their models, and with many it would make the tab endless
  const [open, setOpen] = useState(false);
  const save = useMutation({ mutationFn: (patch: Record<string, unknown>) => api.saveSettings(patch), onSuccess: () => client.invalidateQueries({ queryKey: ["settings"] }) });
  const check = useMutation({ mutationFn: api.checkModelUpdates, onSuccess: (r) => client.setQueryData(["model-updates"], r) });
  // "Get it" per row: each row its own state, one error line for the list
  const rowKey = (u: UpdateRow) => `${u.folder}/${u.file}`;
  const [got, setGot] = useState<Record<string, "pending" | "started">>({});
  const [getError, setGetError] = useState<string | null>(null);
  const mark = (key: string, state?: "pending" | "started") => setGot((m) => {
    const { [key]: _old, ...rest } = m;
    return state ? { ...rest, [key]: state } : rest;
  });
  const get = useMutation({
    mutationFn: (u: UpdateRow) => api.startDownload({ file: u.newer!.file ?? u.file, folder: u.folder, civitai: u.newer!.id, pick: u.newer!.file ?? undefined, page: { url: u.newer!.page, title: `${u.modelName} · ${u.newer!.name}` } }),
    onMutate: (u) => { setGetError(null); mark(rowKey(u), "pending"); },
    onSuccess: (_d, u) => { mark(rowKey(u), "started"); void client.invalidateQueries({ queryKey: ["downloads"] }); },
    onError: (err, u) => { mark(rowKey(u)); setGetError(`${u.modelName || fileLabel(u.file)}: ${err.message}`); },
  });
  const on = Boolean(settings.data?.civitaiLookups);
  const daily = Boolean(settings.data?.updateChecks);
  const fetching = Boolean(settings.data?.downloadModels);
  const r = report.data;
  const newer = (r?.items ?? []).filter((u) => u.newer);
  const needle = q.trim().toLowerCase();
  const [kind, setKind] = useState<"all" | "checkpoints" | "diffusion_models" | "loras">("all");
  const KINDS: Array<{ id: "checkpoints" | "diffusion_models" | "loras"; label: string }> = [{ id: "checkpoints", label: "Checkpoints" }, { id: "diffusion_models", label: "Diffusion models" }, { id: "loras", label: "LoRAs" }];
  const shown = newer.filter((u) => (kind === "all" || u.folder === kind) && (!needle || `${u.modelName} ${u.file} ${u.versionName} ${u.newer!.name}`.toLowerCase().includes(needle)));
  // grouped by what they are: checkpoints, diffusion models, LoRAs
  const groups = KINDS.map((k) => ({ ...k, items: shown.filter((u) => u.folder === k.id) })).filter((g) => g.items.length);
  const day = (iso: string | null) => (iso ? dayOf(iso) : "");
  return (
    <Card setting="models.updates" title="Newer versions on Civitai" status={on && newer.length > 0 ? <span className="font-mono text-xs text-accent">{newer.length} newer</span> : undefined}>
      {!on ? (
        // the switch itself, here too: a check asks Civitai, which only this switch allows
        <Row label="Search Hugging Face and Civitai" sub="needed to check" help="A check asks Civitai, which only this switch allows. The same switch as in Missing models.">
          <Toggle bare on={on} onChange={(v) => save.mutate({ civitaiLookups: v })} label="Search Hugging Face and Civitai for missing models" />
        </Row>
      ) : (
        <>
          <Row label="Check once a day" help="A file is known to Civitai by its hash: the fingerprint a LoRA's trainer wrote in it, or the SHA-256 of the file, computed here once for files on this disk (a few per check). The hash says which file you have, and that is what is sent. A version that differs from yours only by its precision (int4, int8, fp8…) is a variant, not a newer version. Nothing is fetched or replaced by itself.">
            <Toggle bare on={daily} onChange={(v) => save.mutate({ updateChecks: v })} label="Check once a day" />
          </Row>
          <Row
            label="Last check"
            sub={r?.error ? <span className="text-warn-ink">did not go through: {r.error}</span> : undefined}
            help={r?.checkedAt && !check.isPending ? `${r.items.length} file${r.items.length === 1 ? "" : "s"} matched, ${newer.length} with a newer version${r.unmatched ? `, ${r.unmatched} not on Civitai or not readable` : ""}${r.hashesLeft ? `, ${r.hashesLeft} still to hash` : ""}.` : undefined}
          >
            <span className="min-w-0 grow text-xs text-ink-2">
              {check.isPending
                ? "Asking Civitai, hashing a few files…"
                : r?.checkedAt
                  ? <span className="font-mono">{dateTime(r.checkedAt)} · {r.items.length} matched{r.hashesLeft ? ` · ${r.hashesLeft} to hash` : ""}</span>
                  : "Not checked yet."}
            </span>
            <Button size="sm" onClick={() => check.mutate()} disabled={check.isPending}>{check.isPending ? "Checking…" : "Check now"}</Button>
          </Row>
          {newer.length > 0 && (
            <Row label="Newer versions" sub={`${newer.length} of your models`}>
              <Button size="sm" onClick={() => setOpen(true)}>Show the list</Button>
            </Row>
          )}
          {open && (
            <Dialog label="Newer versions on Civitai" onClose={() => setOpen(false)} className={cx(DIALOG.replace("max-w-md", ""), "max-h-[88vh] w-[min(1180px,94vw)]")}>
              <DialogHead icon={<RefreshCw size={16} />} title="Newer versions on Civitai" sub={`${newer.length} of your models · ${r?.checkedAt ? `checked ${dateTime(r.checkedAt)}` : "not checked yet"}`} onClose={() => setOpen(false)} />
              <div className="flex flex-wrap items-center gap-2">
                <Segmented label="Kind" value={kind} onChange={(v) => setKind(v as typeof kind)} options={[{ value: "all", label: `All ${newer.length}` }, ...KINDS.map((k) => ({ value: k.id, label: `${k.label} ${newer.filter((u) => u.folder === k.id).length}` })).filter((o) => !o.label.endsWith(" 0"))]} />
                <label className="flex h-8 grow items-center gap-2 rounded-lg border border-line bg-raised px-2.5">
                  <Search size={13} className="shrink-0 text-ink-3" />
                  <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${newer.length}`} className="min-w-0 grow bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" />
                </label>
              </div>
              {/* its own scroll, the head kept in view; what you have and what is newer on one line, so it fits */}
              <div className="min-h-0 overflow-y-auto rounded-xl border border-line">
                <table className="w-full table-fixed text-sm">
                  <thead className="sticky top-0 z-10 bg-raised text-left text-[11px] tracking-wide text-ink-2 uppercase">
                    <tr><th className="w-[46%] py-1.5 pr-3 pl-3.5 font-semibold">Model</th><th className="px-3 py-1.5 font-semibold">You have → newer</th><th className="w-[130px] px-3 py-1.5" /></tr>
                  </thead>
                  {groups.map((g) => (
                  <tbody key={g.id}>
                    <tr className="border-t border-line bg-raised/60"><th colSpan={3} className="py-1.5 pr-3 pl-3.5 text-left text-xs font-semibold text-ink-2">{g.label} · {g.items.length}</th></tr>
                    {g.items.map((u) => (
                      <tr key={`${u.folder}/${u.file}`} className="border-t border-line align-top">
                        <td className="py-2 pr-3 pl-3.5">
                          <span className="block truncate font-semibold" data-tip={u.modelName || undefined}>{u.modelName || fileLabel(u.file)}</span>
                          <span className="block truncate text-xs text-ink-3" data-tip={`${u.folder}/${u.file}`}>{u.folder}/{u.file}</span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="block truncate"><span className="text-ink-2">{u.versionName || "older"}</span> <span className="text-ink-3">→</span> <span className="font-semibold">{u.newer!.name}</span></span>
                          {u.newer!.publishedAt && <span className="block font-mono text-xs text-ink-3">{day(u.newer!.publishedAt)}</span>}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <a href={u.newer!.page} target="_blank" rel="noreferrer" className="mr-2 text-xs font-semibold underline">Open</a>
                          {fetching && (got[rowKey(u)] === "started"
                            ? <span className="text-xs text-good">Started</span>
                            : <Button size="sm" onClick={() => get.mutate(u)} disabled={got[rowKey(u)] === "pending"} data-tip="Fetch the newer version into the same folder. The file you have stays until you remove it.">{got[rowKey(u)] === "pending" ? "Starting…" : "Get it"}</Button>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  ))}
                </table>
                {!shown.length && <div className="p-4 text-xs text-ink-3">Nothing matches.</div>}
              </div>
              {getError && <ErrorNote>{getError}</ErrorNote>}
            </Dialog>
          )}
        </>
      )}
      {(check.isError || save.isError) && <Block><ErrorNote>{(check.error ?? save.error)?.message}</ErrorNote></Block>}
    </Card>
  );
}
