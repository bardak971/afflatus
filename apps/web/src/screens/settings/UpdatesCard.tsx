import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api, type UpdateRow } from "../../api";
import { useModelUpdates, useSettings } from "../../data";
import { fileLabel } from "../../format";
import { Button, ErrorNote, Segmented, Toggle } from "../../ui";

/** Newer versions of the models here, on Civitai: a check on request, and once a day when asked for. Its own card, wide: the list can be long. */
export function UpdatesCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const report = useModelUpdates();
  const [q, setQ] = useState("");
  const save = useMutation({ mutationFn: (patch: Record<string, unknown>) => api.saveSettings(patch), onSuccess: () => client.invalidateQueries({ queryKey: ["settings"] }) });
  const check = useMutation({ mutationFn: api.checkModelUpdates, onSuccess: (r) => client.setQueryData(["model-updates"], r) });
  const get = useMutation({
    mutationFn: (u: UpdateRow) => api.startDownload({ file: u.newer!.file ?? u.file, folder: u.folder, civitai: u.newer!.id, pick: u.newer!.file ?? undefined, page: { url: u.newer!.page, title: `${u.modelName} · ${u.newer!.name}` } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["downloads"] }),
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
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "");
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">Newer versions on Civitai</h2>
      {!on ? (
        <div className="text-ink-2">Turn on "Search Hugging Face and Civitai" (on the right) to have your models checked against Civitai.</div>
      ) : (
        <>
          <Toggle on={daily} onChange={(v) => save.mutate({ updateChecks: v })} label="Check once a day" />
          <div className="text-xs text-ink-3">
            A file is known to Civitai by its hash: the fingerprint a LoRA's trainer wrote in it, or the SHA-256 of the file, computed here once for files on this disk (a few per check). The hash says which file you have, and that is what is sent. A version that differs from yours only by its precision (int4, int8, fp8…) is a variant, not a newer version. Nothing is fetched or replaced by itself.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => check.mutate()} disabled={check.isPending}>{check.isPending ? "Checking…" : "Check now"}</Button>
            <span className="min-w-0 grow text-xs text-ink-2">
              {check.isPending
                ? "Asking Civitai, hashing a few files…"
                : r?.checkedAt
                  ? `Last check ${new Date(r.checkedAt).toLocaleString()}: ${r.items.length} file${r.items.length === 1 ? "" : "s"} matched, ${newer.length} with a newer version${r.unmatched ? `, ${r.unmatched} not on Civitai or not readable` : ""}${r.hashesLeft ? `, ${r.hashesLeft} still to hash` : ""}.`
                  : "Not checked yet."}
            </span>
            {newer.length > 8 && (
              <Segmented label="Kind" value={kind} onChange={(v) => setKind(v as typeof kind)} options={[{ value: "all", label: `All ${newer.length}` }, ...KINDS.map((k) => ({ value: k.id, label: `${k.label} ${newer.filter((u) => u.folder === k.id).length}` })).filter((o) => !o.label.endsWith(" 0"))]} />
            )}
            {newer.length > 8 && (
              <label className="flex h-8 items-center gap-2 rounded-lg border border-line bg-raised px-2.5">
                <Search size={13} className="shrink-0 text-ink-3" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${newer.length}`} className="w-40 min-w-0 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" />
              </label>
            )}
          </div>
          {shown.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-line">
              <table className="w-full text-sm">
                <thead className="bg-raised text-left text-[11px] tracking-wide text-ink-2 uppercase">
                  <tr><th className="px-3 py-1.5 font-semibold">Model</th><th className="px-3 py-1.5 font-semibold">You have</th><th className="px-3 py-1.5 font-semibold">Newer</th><th className="px-3 py-1.5" /></tr>
                </thead>
                {groups.map((g) => (
                <tbody key={g.id}>
                  <tr className="border-t border-line bg-raised/60"><th colSpan={4} className="px-3 py-1.5 text-left text-xs font-semibold text-ink-2">{g.label} · {g.items.length}</th></tr>
                  {g.items.map((u) => (
                    <tr key={`${u.folder}/${u.file}`} className="border-t border-line align-top">
                      <td className="max-w-[360px] px-3 py-2">
                        <span className="block truncate font-semibold">{u.modelName || fileLabel(u.file)}</span>
                        <span className="block truncate text-xs text-ink-3" title={`${u.folder}/${u.file}`}>{u.folder}/{u.file}</span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-ink-2">{u.versionName || "an older version"}</td>
                      <td className="px-3 py-2 whitespace-nowrap"><span className="font-semibold">{u.newer!.name}</span>{u.newer!.publishedAt && <span className="text-ink-2"> · {day(u.newer!.publishedAt)}</span>}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <a href={u.newer!.page} target="_blank" rel="noreferrer" className="mr-2 text-xs font-semibold underline">Open</a>
                        {fetching && <Button size="sm" onClick={() => get.mutate(u)} disabled={get.isPending} title="Fetch the newer version into the same folder. The file you have stays until you remove it.">Get it</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                ))}
              </table>
            </div>
          )}
          {(check.isError || get.isError || save.isError) && <ErrorNote>{(check.error ?? get.error ?? save.error)?.message}</ErrorNote>}
        </>
      )}
    </section>
  );
}
