import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings, useStorage } from "../../data";
import { size } from "../../format";
import { Button, cx, ErrorNote, Segmented, TwoStep } from "../../ui";

/** Where the space goes, and the two ways to get some back. */
export function StorageCard() {
  const storage = useStorage();
  const client = useQueryClient();
  // the library, the folders and the disk use follow the server's "library" event; the timelines may have played what went
  const done = () => void client.invalidateQueries({ queryKey: ["timelines"] });
  const idle = useMutation({ mutationFn: api.binIdleTakes, onSuccess: done });
  const empty = useMutation({ mutationFn: api.emptyBin, onSuccess: done });
  const s = storage.data;
  const parts = s ? [
    { label: "Videos that play, or are in your library", bytes: s.videos, tone: "bg-accent" },
    { label: "Takes that never play", bytes: s.idleTakes.bytes, tone: "bg-warn" },
    { label: "Images", bytes: s.pictures, tone: "bg-picture" },
    { label: "Audio", bytes: s.sounds, tone: "bg-good" },
    { label: "Bin", bytes: s.bin.bytes, tone: "bg-ink-3" },
  ] : [];
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold">Storage</h2>
        {s && <span className="text-ink-2">{size(s.total)} used</span>}
      </div>
      {storage.isError && <ErrorNote>{storage.error.message}</ErrorNote>}
      {s && s.total > 0 && (
        <div className="flex h-2.5 overflow-hidden rounded-full bg-line">
          {parts.map((p) => <div key={p.label} className={p.tone} style={{ width: `${(p.bytes / s.total) * 100}%` }} />)}
        </div>
      )}
      {s && (
        <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1.5">
          {parts.map((p) => (
            <div key={p.label} className="contents">
              <span className={cx("h-2.5 w-2.5 rounded-sm", p.tone)} />
              <dt className="text-ink-2">{p.label}</dt>
              <dd className="font-mono">{size(p.bytes)}</dd>
            </div>
          ))}
        </dl>
      )}
      {s && s.idleTakes.count > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5">
          <span>{s.idleTakes.count} take{s.idleTakes.count > 1 ? "s are" : " is"} not the one that plays in {s.idleTakes.count > 1 ? "their" : "its"} clip.</span>
          <Button size="sm" disabled={idle.isPending} onClick={() => idle.mutate()}>Move {s.idleTakes.count > 1 ? "them" : "it"} to the bin · {size(s.idleTakes.bytes)}</Button>
        </div>
      )}
      {s && s.bin.count > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5">
          <span>Bin: {s.bin.count} thing{s.bin.count > 1 ? "s" : ""}, kept 7 days before {s.bin.count > 1 ? "they are" : "it is"} deleted.</span>
          <TwoStep label="Empty it now" title="Everything in the bin is erased now, files and all, instead of after its 7 days" note="This cannot be undone." yes={`Erase ${size(s.bin.bytes)}`} busy={empty.isPending} onYes={() => empty.mutate()} />
        </div>
      )}
      {(idle.isError || empty.isError) && <ErrorNote>{(idle.error ?? empty.error)?.message}</ErrorNote>}
      {empty.data?.inUse ? <div className="text-xs text-ink-2">{empty.data.inUse} item{empty.data.inUse === 1 ? " was" : "s were"} left in the bin: a timeline, a person or a waiting job still uses {empty.data.inUse === 1 ? "it" : "them"}.</div> : null}
      <div className="text-xs text-ink-3">
        Outputs you do not keep go to the bin after 24 hours{s && s.unkept.count ? ` (${s.unkept.count} now, ${size(s.unkept.bytes)})` : ""}. What is on a timeline is always kept.
      </div>
      <Backup />
      <RenderRecord />
    </section>
  );
}

/** One zip of everything Afflatus keeps, made while it runs: the database and every file. */
function Backup() {
  const plan = useQuery({ queryKey: ["storage", "backup-plan"], queryFn: api.backupPlan, staleTime: 60_000 });
  const p = plan.data;
  if (p && !p.available) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">Backup</span>
        <a href="/api/backup.zip" download className="inline-flex h-8 items-center rounded-lg border border-line-strong bg-raised px-3 text-xs font-semibold hover:bg-hover">Back up now{p ? ` · about ${size(p.bytes)}` : ""}</a>
      </div>
      <span className="text-xs text-ink-3">
        One zip, made while Afflatus runs: {p?.database ? "the database (a consistent copy) and " : ""}every file of the library{p ? ` (${p.files} files)` : ""}. Not in it: the files of linked folders, which stay on your disk, and ComfyUI's models.
        To restore, stop Afflatus, unpack the zip into an empty data folder (<code>pnpm restore &lt;zip&gt; &lt;folder&gt;</code> does it, and refuses a folder that is not empty), and start it again with DATA_DIR pointing there.{p && !p.database ? " With Postgres, back the database up with Postgres's own tools." : ""}
      </span>
    </div>
  );
}

const KEEP_FOR = [{ value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "365", label: "A year" }, { value: "0", label: "For good" }];

/** The record of render times (Queue, "Render times"): how long each render is kept one by one, how much room it takes, and a way to forget it. */
function RenderRecord() {
  const client = useQueryClient();
  const settings = useSettings();
  const record = useQuery({ queryKey: ["renders", "size"], queryFn: api.renderRecordSize });
  const forget = useMutation({ mutationFn: api.clearRenderRecord, onSuccess: () => client.invalidateQueries({ queryKey: ["renders"] }) });
  const keep = useMutation({ mutationFn: (days: number) => api.saveSettings({ renderHistoryDays: days }), onSuccess: (saved) => client.setQueryData(["settings"], saved) });
  const r = record.data;
  const days = settings.data?.renderHistoryDays ?? 90;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          Render times{r ? `: ${r.renders} render${r.renders === 1 ? "" : "s"} one by one${r.days ? `, ${r.days} day${r.days === 1 ? "" : "s"} as figures` : ""} · ${size(r.bytes)}` : ""}
        </span>
        <div className="w-72"><Segmented label="How long each render is kept one by one" value={String(days)} options={KEEP_FOR} onChange={(v) => keep.mutate(Number(v))} /></div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
        <span>What the Queue's "Render times" and the estimates on the buttons are made from. Older renders are folded into one line per model and day, kept for good: the charts still reach back, the list does not.</span>
        <TwoStep label="Forget every render time" title="Forget every render time" note="The estimates start again from nothing." yes="Forget them" busy={forget.isPending} disabled={!r || (!r.renders && !r.days)} onYes={() => forget.mutate()} />
      </div>
      {(forget.isError || keep.isError) && <ErrorNote>{(forget.error ?? keep.error)?.message}</ErrorNote>}
    </div>
  );
}
