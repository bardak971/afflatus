import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Search } from "lucide-react";
import { api, type UpdateRow } from "../../api";
import { useModelUpdates, useSettings } from "../../data";
import { fileLabel } from "../../format";
import { Button, ErrorNote, Segmented, Toggle } from "../../ui";
import { Block, Card, Row } from "./Rows";

/** Newer versions of the models here, on Civitai: a check on request, and once a day when asked for. Its own card, wide: the list can be long. */
export function UpdatesCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const report = useModelUpdates();
  const [q, setQ] = useState("");
  // the list folded by default: with many models it would make the tab endless
  const [open, setOpen] = useState(false);
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
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB") : "");
  return (
    <Card title="Newer versions on Civitai" status={on && newer.length > 0 ? <span className="font-mono text-xs text-accent">{newer.length} newer</span> : undefined}>
      {!on ? (
        <Row label="Check against Civitai" help={`Needs "Search Hugging Face and Civitai" on, in Missing models above.`}>
          <span className="text-xs text-ink-3">needs Civitai search on</span>
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
                  ? <span className="font-mono">{new Date(r.checkedAt).toLocaleString("en-GB")} · {r.items.length} matched{r.hashesLeft ? ` · ${r.hashesLeft} to hash` : ""}</span>
                  : "Not checked yet."}
            </span>
            <Button size="sm" onClick={() => check.mutate()} disabled={check.isPending}>{check.isPending ? "Checking…" : "Check now"}</Button>
          </Row>
          {newer.length > 0 && (
            <Row label="Newer versions" sub={`${newer.length} of your models`}>
              <Button size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? "Hide the list" : `Show ${newer.length}`} <ChevronDown size={13} className={open ? "rotate-180" : ""} />
              </Button>
            </Row>
          )}
          {open && newer.length > 8 && (
            <Row label="Filter">
              <Segmented label="Kind" value={kind} onChange={(v) => setKind(v as typeof kind)} options={[{ value: "all", label: `All ${newer.length}` }, ...KINDS.map((k) => ({ value: k.id, label: `${k.label} ${newer.filter((u) => u.folder === k.id).length}` })).filter((o) => !o.label.endsWith(" 0"))]} />
              <label className="flex h-8 items-center gap-2 rounded-lg border border-line bg-raised px-2.5">
                <Search size={13} className="shrink-0 text-ink-3" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${newer.length}`} className="w-40 min-w-0 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" />
              </label>
            </Row>
          )}
          {open && shown.length > 0 && (
            // its own scroll, the head kept in view: the page stays as long as the other tabs
            <div className="max-h-[520px] overflow-y-auto border-t border-line">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-raised text-left text-[11px] tracking-wide text-ink-2 uppercase">
                  <tr><th className="py-1.5 pr-3 pl-[18px] font-semibold">Model</th><th className="px-3 py-1.5 font-semibold">You have</th><th className="px-3 py-1.5 font-semibold">Newer</th><th className="px-3 py-1.5" /></tr>
                </thead>
                {groups.map((g) => (
                <tbody key={g.id}>
                  <tr className="border-t border-line bg-raised/60"><th colSpan={4} className="py-1.5 pr-3 pl-[18px] text-left text-xs font-semibold text-ink-2">{g.label} · {g.items.length}</th></tr>
                  {g.items.map((u) => (
                    <tr key={`${u.folder}/${u.file}`} className="border-t border-line align-top">
                      <td className="max-w-[360px] py-2 pr-3 pl-[18px]">
                        <span className="block truncate font-semibold">{u.modelName || fileLabel(u.file)}</span>
                        <span className="block truncate text-xs text-ink-3" data-tip={`${u.folder}/${u.file}`}>{u.folder}/{u.file}</span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-ink-2">{u.versionName || "an older version"}</td>
                      <td className="px-3 py-2 whitespace-nowrap"><span className="font-semibold">{u.newer!.name}</span>{u.newer!.publishedAt && <span className="text-ink-2"> · {day(u.newer!.publishedAt)}</span>}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <a href={u.newer!.page} target="_blank" rel="noreferrer" className="mr-2 text-xs font-semibold underline">Open</a>
                        {fetching && <Button size="sm" onClick={() => get.mutate(u)} disabled={get.isPending} data-tip="Fetch the newer version into the same folder. The file you have stays until you remove it.">Get it</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                ))}
              </table>
            </div>
          )}
          {(check.isError || get.isError || save.isError) && <Block><ErrorNote>{(check.error ?? get.error ?? save.error)?.message}</ErrorNote></Block>}
        </>
      )}
    </Card>
  );
}
