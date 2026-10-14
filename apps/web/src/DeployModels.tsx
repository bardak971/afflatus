import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { X } from "lucide-react";
import { fileKey } from "@afflatus/core";
import { api, type DeployAsk, type DeployFile, type DeployModels as View, type MeasuredRange, type PresetFile } from "./api";
import { est, gb, plural, size, usd } from "./format";
import { openFindModels, useFind, type FindTarget } from "./findModels/store";
import { ViaChip } from "./modelFilesUi";
import { queryKeys } from "./queryKeys";
import { useSayFailed } from "./sayFailed";
import { Select } from "./Select";
import { Button, Checkbox, cx, fieldClass, Help } from "./ui";

const WHY_MODELS = "What the pod gets once it is up, straight from Hugging Face or Civitai (a file no site is known for is sent from this PC). Your waiting jobs' files come first, in the order the queue needs them: a job starts as soon as its own files are there. A job whose file you untick stays home. Fetching is billed GPU time: the time and price are measured on your own deploys (the speeds of each source), or not said. A file fetched never keeps the pod: with nothing to render it goes idle and ends on time.";

/** What the Models part asks the deploy to bring: the files ticked, the job files left out, the licences accepted, and whether it may go. */
export interface ModelsPicked {
  files: PresetFile[];
  leaveOut: Array<{ file: string; folder: string }>;
  accept: string[];
  /** Every licence of the ticked files accepted. */
  ready: boolean;
  /** Bytes ticked, as far as known: the disk proposed. */
  bytes: number;
}

/** A file's line: its box, its name, what it is for, where it comes from, its size. */
function FileRow({ f, on, onChange, note, dim, disabled }: { f: DeployFile; on: boolean; onChange?(on: boolean): void; note?: string; dim?: boolean; disabled?: boolean }) {
  return (
    <div className={cx("grid grid-cols-[minmax(0,1fr)_auto_64px] items-center gap-3 py-1 text-[13px]", dim && "opacity-55")}>
      <Checkbox checked={on} disabled={disabled || !onChange} onChange={(v) => onChange?.(v)} className="min-w-0">
        {/* the whole name: a model's variants often differ only at its end */}
        <span className="min-w-0 break-all">{f.file}<span className="text-ink-3"> · {f.folder}{note ? ` · ${note}` : ""}</span></span>
      </Checkbox>
      <ViaChip via={f.via} />
      <span className="text-right font-mono text-xs text-ink-3">{f.size ? size(f.size) : "–"}</span>
    </div>
  );
}

/** How long these files take, slowest to fastest (ms), at the speeds measured; null when a source of them was never measured. */
function timeOf(files: DeployFile[], speeds: View["speeds"]): { fast: number; slow: number } | null {
  let fast = 0;
  let slow = 0;
  for (const f of files) {
    if (!f.size || !f.via) continue;
    const r: MeasuredRange | null = speeds[f.via];
    if (!r) return null;
    fast += (f.size / r.high) * 1000;
    slow += (f.size / r.low) * 1000;
  }
  return { fast, slow };
}

/**
 * Deploy a GPU's Models: the waiting jobs' files (ticked), a Model set's, and any file found by words; what that comes to,
 * and what it takes and costs before the first render, from what earlier deploys measured.
 */
export function DeployModels({ want, set, rate, gpu, onPicked }: { want: DeployAsk; set(change: Partial<DeployAsk>): void; rate: number | null; /** The GPU picked, as the browser says what it adds to. */ gpu: string | null; onPicked(p: ModelsPicked): void }) {
  const view = useQuery({ queryKey: queryKeys.deployModels(want.cloud, want.set), queryFn: ({ signal }) => api.deployModels(want.cloud, want.set, { signal }), staleTime: 15_000, retry: false });
  const sets = useQuery({ queryKey: queryKeys.modelSets.all(), queryFn: ({ signal }) => api.modelSets({ signal }), staleTime: 30_000 });
  const [jobOff, setJobOff] = useState<Set<string>>(() => new Set());
  const [setOff, setSetOff] = useState<Set<string> | null>(null);
  const [added, setAdded] = useState<DeployFile[]>([]);
  const [accept, setAccept] = useState<Set<string>>(() => new Set());
  const v = view.data;
  // a set picked anew: its own ticks (a preset's file left out of the set starts unticked)
  useEffect(() => setSetOff(null), [want.set]);
  const setOffNow = useMemo(() => setOff ?? new Set((v?.set ?? []).filter((f) => f.off).map(fileKey)), [setOff, v]);

  // what goes, each file once (the jobs', then the set's, then the ones added), only files that can reach the pod
  const picked = useMemo(() => {
    const jobKeys = new Set((v?.jobs.files ?? []).map(fileKey));
    const jobs = (v?.jobs.files ?? []).filter((f) => f.via && !jobOff.has(fileKey(f)));
    const fromSet = (v?.set ?? []).filter((f) => f.via && !jobKeys.has(fileKey(f)) && !setOffNow.has(fileKey(f)));
    const once = new Map<string, DeployFile>();
    for (const f of [...jobs, ...fromSet, ...added.filter((x) => x.via)]) if (!once.has(fileKey(f))) once.set(fileKey(f), f);
    return { jobKeys, jobs, all: [...once.values()] };
  }, [v, jobOff, setOffNow, added]);
  const bytes = picked.all.reduce((n, f) => n + (f.size ?? 0), 0);
  const uploadBytes = picked.all.filter((f) => f.via === "upload").reduce((n, f) => n + (f.size ?? 0), 0);
  const unknownSizes = picked.all.filter((f) => !f.size).length;
  // a licence for every preset whose files go, whichever way they were picked (the server asks the same)
  const pickedKeys = new Set(picked.all.map(fileKey));
  const licences = (v?.licences ?? []).filter((l) => l.keys.some((k) => pickedKeys.has(k)));
  const ready = licences.every((l) => accept.has(l.id));
  const leaveOut = useMemo(() => (v?.jobs.files ?? []).filter((f) => jobOff.has(fileKey(f)) || !f.via).map(({ file, folder }) => ({ file, folder })), [v, jobOff]);

  useEffect(() => {
    onPicked({
      files: picked.all.map(({ file, folder, url, civitai, size: s }) => ({ file, folder, ...(url ? { url } : {}), ...(civitai ? { civitai } : {}), ...(s ? { size: s } : {}) })),
      leaveOut,
      accept: [...accept],
      ready,
      bytes,
    });
  }, [picked, leaveOut, accept, ready, bytes, onPicked]);

  const time = v ? timeOf(picked.all, v.speeds) : null;
  const firstFiles = picked.jobs.filter((f) => f.first);
  const first = v ? timeOf(firstFiles, v.speeds) : null;
  const toggled = (from: Set<string>, f: DeployFile, on: boolean) => {
    const n = new Set(from);
    if (on) n.delete(fileKey(f));
    else n.add(fileKey(f));
    return n;
  };
  const add = useCallback((files: DeployFile[]) => setAdded((a) => [...a, ...files.filter((f) => !a.some((x) => fileKey(x) === fileKey(f)))]), []);
  // what Find models adds to: this deploy, its time and price at the speeds measured on this cloud and the GPU's rate, as below
  const findTarget = useCallback((): FindTarget => ({
    what: gpu ? `Deploy · ${gpu}` : "this deploy", action: "Add to this deploy", add,
    estimate: (files) => {
      const t = v ? timeOf(files, v.speeds) : null;
      return t && rate !== null ? `${est(t.fast)}–${est(t.slow).replace(/^~/, "")} · ${usd((t.fast / 3_600_000) * rate, true)}–${usd((t.slow / 3_600_000) * rate, true)}` : null;
    },
  }), [gpu, add, v, rate]);
  // open, it follows this dialog: a GPU picked anew, its rate, or the speeds read again (another cloud) give it a new estimate
  const finding = useRef<FindTarget | null>(null);
  useEffect(() => {
    if (!finding.current || useFind.getState().target !== finding.current) return;
    finding.current = findTarget();
    openFindModels(finding.current);
  }, [findTarget]);

  return (
    <section className="flex flex-col gap-2">
      <span className="flex items-center gap-2 text-xs font-semibold text-ink-2">Models <Help text={WHY_MODELS} /></span>
      {view.isPending && <span className="text-xs text-ink-3">Reading your waiting jobs…</span>}
      {v && (
        <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
          <div className="flex flex-col">
            <span className="flex items-center gap-2 pb-1 text-[13px] font-semibold">
              Your waiting jobs<span className="font-normal text-ink-3">{v.jobs.count ? ` · ${plural(v.jobs.count, "job")} · fetched first, in queue order` : " · none waiting"}</span>
            </span>
            {v.jobs.files.map((f) => (
              <FileRow key={fileKey(f)} f={f} on={Boolean(f.via) && !jobOff.has(fileKey(f))} disabled={!f.via} onChange={(on) => setJobOff((s) => toggled(s, f, on))} note={plural(f.jobs, "job")} />
            ))}
            {v.jobs.files.some((f) => !f.via) && <span className="pt-1 text-xs text-warn-ink">A file with no source known and no copy on this PC cannot reach the pod: its jobs stay home.</span>}
            {v.jobs.files.length > 0 && <span className="pt-1 text-xs text-ink-3">Untick a file: its jobs stay home.</span>}
          </div>

          <div className="flex flex-col">
            <span className="flex items-center gap-2 pb-1 text-[13px] font-semibold">
              Model set
              <span className="w-[200px] font-normal">
                <Select size="sm" label="Model set" value={want.set || "none"} onChange={(id) => set({ set: id === "none" ? "" : id })} options={[{ value: "none", label: "None" }, ...(sets.data?.items ?? []).map((s) => ({ value: s.id, label: s.name, note: `${plural(s.count, "file")} · ${gb(s.bytes)}` }))]} />
              </span>
              <Link href="/settings/models" className="text-xs font-normal text-ink-3 underline-offset-2 hover:text-ink hover:underline">edit sets in Settings › Models</Link>
            </span>
            {(v.set ?? []).map((f) => {
              const above = picked.jobKeys.has(fileKey(f));
              return <FileRow key={fileKey(f)} f={f} on={!above && Boolean(f.via) && !setOffNow.has(fileKey(f))} dim={above} disabled={above || !f.via} onChange={(on) => setSetOff(toggled(setOffNow, f, on))} note={above ? "above already" : f.preset ? `from ${f.preset.name}` : undefined} />;
            })}
          </div>

          <div className="flex flex-col gap-1">
            {added.map((f) => (
              <div key={fileKey(f)} className="flex items-center gap-2">
                <span className="min-w-0 grow"><FileRow f={f} on={Boolean(f.via)} note={f.via ? undefined : "no source: not sent"} /></span>
                <button type="button" aria-label={`Take ${f.file} off`} onClick={() => setAdded((a) => a.filter((x) => fileKey(x) !== fileKey(f)))} className="grid size-6 place-items-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"><X size={12} /></button>
              </div>
            ))}
            {/* the rest is found in Find models: yours, Civitai, Hugging Face */}
            <span className="flex items-center gap-2">
              <Button size="sm" onClick={() => { finding.current = findTarget(); openFindModels(finding.current); }}>Find more…</Button>
              <span className="text-xs text-ink-3">your presets and files, Civitai, Hugging Face</span>
            </span>
          </div>

          {licences.map((l) => (
            <Checkbox key={l.id} checked={accept.has(l.id)} onChange={(on) => setAccept((s) => { const n = new Set(s); if (on) n.add(l.id); else n.delete(l.id); return n; })} className="text-xs">
              <span>I accept the {l.licence} for {l.name}'s files</span>
            </Checkbox>
          ))}

          <div className="flex flex-col gap-0.5 border-t border-line pt-2 text-xs text-ink-2">
            {/* nothing picked: nothing to time or price */}
            {!picked.all.length ? <span>Nothing to fetch: the pod starts with what its image holds, and gets a job's files when it takes one.</span> : (
            <span>
              <b className="font-mono text-ink">{gb(bytes)}</b> to fetch
              {uploadBytes > 0 && ` · ${size(uploadBytes)} from this PC`}
              {unknownSizes > 0 && ` · ${plural(unknownSizes, "file")} of a size not known yet`}
              {" · "}
              {time && rate !== null
                ? <>{est(time.fast)}–{est(time.slow).replace(/^~/, "")} · <b className="text-ink">{usd((time.fast / 3_600_000) * rate, true)}–{usd((time.slow / 3_600_000) * rate, true)}</b> at {usd(rate)}/h</>
                : "time and price not known yet: measured from your first deploy"}
            </span>)}
            {v.boot && first && rate !== null && firstFiles.length > 0 && (
              <span>Before your first render: up in {est(v.boot.high)}, then its {gb(firstFiles.reduce((n, f) => n + (f.size ?? 0), 0))} · <b className="text-ink">{est(v.boot.high + first.slow)} · ~{usd(((v.boot.high + first.slow) / 3_600_000) * rate, true)}</b></span>
            )}
            {!ready && <span className="text-warn-ink">Accept the licence above to deploy with those files.</span>}
          </div>
        </div>
      )}
      {view.isError && <span className="text-xs text-warn-ink">{view.error.message}</span>}
    </section>
  );
}

/** "Save these as a set…": the files ticked, named in place; the new set listed at once in the dialog and in Settings › Models. */
export function SaveAsSet({ files }: { files: PresetFile[] }) {
  const client = useQueryClient();
  const sayFailed = useSayFailed({ href: "/settings/models", go: "Open Settings › Models" });
  const [name, setName] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (n: string) => api.saveModelSet(null, { name: n, presets: [], files, off: [] }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.modelSets.all() }),
    onError: sayFailed("The set was not saved"),
  });
  if (!files.length) return null;
  if (save.isSuccess) return <span className="self-start text-xs text-good">Saved as “{save.data.name}”</span>;
  if (name === null) return <Button size="sm" tone="quiet" onClick={() => setName("")} className="self-start">Save these as a set…</Button>;
  return (
    <form className="flex items-center gap-2 self-start" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !save.isPending) save.mutate(name.trim()); }}>
      <input autoFocus aria-label="The set's name" placeholder="Name of the set" value={name} onChange={(e) => setName(e.target.value)} className={cx(fieldClass, "h-7 w-40 px-2 text-xs")} />
      <Button size="sm" type="submit" disabled={!name.trim() || save.isPending}>Save</Button>
    </form>
  );
}
