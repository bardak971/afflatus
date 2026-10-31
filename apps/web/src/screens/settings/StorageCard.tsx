import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings, useStorage } from "../../data";
import { plural, size, verb } from "../../format";
import { Button, ButtonLink, cx, Failed, Segmented, TwoStep } from "../../ui";
import { firstFailed } from "../../sayFailed";
import { Block, Card, Row } from "./Rows";
import { daysSaid, insteadOfWaiting } from "../../keepFor";
import { queryKeys } from "../../queryKeys";
import { COLUMNS } from "./wide";
import { SETTING_HELP } from "@afflatus/core";

/** Where the space goes, and the two ways to get some back. */
export function StorageCard() {
  const storage = useStorage();
  const client = useQueryClient();
  // the library, the folders and the disk use follow the server's "library" event; the timelines may have played what went
  const done = () => void client.invalidateQueries({ queryKey: queryKeys.timelines.all() });
  const idle = useMutation({ mutationFn: api.binIdleTakes, onSuccess: done });
  const empty = useMutation({ mutationFn: api.emptyBin, onSuccess: done });
  // how long the library waits on its own: the server's sweep reads these (the hourly one, the next after a change)
  const settings = useSettings();
  const keepFor = useMutation({ mutationFn: (patch: { unkeptDays?: 0 | 1 | 3 | 7; binDays?: 0 | 7 | 30; jobHistoryDays?: number }) => api.saveSettings(patch), onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved) });
  const binFailed = firstFailed([["Idle takes not binned", idle], ["Bin not emptied", empty], ["Not saved", keepFor]]);
  const unkeptDays = settings.data?.unkeptDays ?? 1;
  const binDays = settings.data?.binDays ?? 7;
  const jobDays = settings.data?.jobHistoryDays ?? 30;
  const s = storage.data;
  const parts = s ? [
    { label: "Videos that play, or are in your library", bytes: s.videos, tone: "bg-accent" },
    // a faded video colour: they are videos too, only idle; the warn red read as an error
    { label: "Takes that never play", bytes: s.idleTakes.bytes, tone: "bg-accent/40" },
    { label: "Images", bytes: s.pictures, tone: "bg-picture" },
    { label: "Audio", bytes: s.sounds, tone: "bg-good" },
    { label: "Bin", bytes: s.bin.bytes, tone: "bg-ink-3" },
  ] : [];
  return (
    // two columns in a wide window, as the other tabs: the disk on the left, the backup and the render times on the right
    <div className={COLUMNS}>
      <div className="flex flex-col gap-4">
        <Card setting="storage.disk" title="Disk" status={s && <span className="font-mono text-xs text-ink-2">{size(s.total)} used</span>}>
          {storage.isError && <Block><Failed what="Storage not loaded" error={storage.error} /></Block>}
          {s && (
            <Block className="gap-3 py-4">
              {s.total > 0 && (
                <div className="flex h-2.5 overflow-hidden rounded-full bg-line">
                  {parts.map((p) => <div key={p.label} className={p.tone} style={{ width: `${(p.bytes / s.total) * 100}%` }} />)}
                </div>
              )}
              <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1.5">
                {parts.map((p) => (
                  <div key={p.label} className="contents">
                    <span className={cx("h-2.5 w-2.5 rounded-sm", p.tone)} />
                    <dt className="text-ink-2">{p.label}</dt>
                    <dd className="text-right font-mono">{size(p.bytes)}</dd>
                  </div>
                ))}
              </dl>
            </Block>
          )}
          {s && s.idleTakes.count > 0 && (
            <Row setting="storage.idle" label="Takes that never play" sub={`${plural(s.idleTakes.count, "take")}`} help={`${s.idleTakes.count > 1 ? "These takes are" : "This take is"} not the one that plays in ${s.idleTakes.count > 1 ? "their" : "its"} clip. ${binDays ? `In the bin they are kept ${daysSaid(binDays)}, then deleted.` : "In the bin they are kept until you empty it."}`}>
              <Button size="sm" disabled={idle.isPending} onClick={() => idle.mutate()}>Move {s.idleTakes.count > 1 ? "them" : "it"} to the bin · {size(s.idleTakes.bytes)}</Button>
            </Row>
          )}
          {s && (
            <Row
              setting="storage.bin"
              label="Bin"
              sub={s.bin.count > 0 ? `${plural(s.bin.count, "item")} · ${size(s.bin.bytes)}` : "empty"}
              help={`${binDays ? `Kept ${daysSaid(binDays)} before it is deleted.` : "Kept until you empty it."} ${unkeptDays ? `Outputs you do not keep go to the bin after ${daysSaid(unkeptDays)}` : "Outputs you do not keep stay until you bin them"}${s.unkept.count ? ` (${s.unkept.count} not kept now, ${size(s.unkept.bytes)})` : ""}. What is on a timeline is always kept.`}
            >
              {s.bin.count > 0 && <TwoStep label="Empty the bin" tone="danger" title={`Everything in the bin is erased now, files and all, instead of ${insteadOfWaiting(binDays)}`} note="This cannot be undone." yes={`Erase ${size(s.bin.bytes)}`} busy={empty.isPending} onYes={() => empty.mutate()} />}
            </Row>
          )}
          <Row setting="storage.unkeptDays" label="Unkept renders go to the bin after" help={SETTING_HELP.unkeptDays}>
            <Segmented oneLine label="Unkept renders go to the bin after" value={String(unkeptDays)} options={UNKEPT_FOR} onChange={(v) => keepFor.mutate({ unkeptDays: Number(v) as 0 | 1 | 3 | 7 })} />
          </Row>
          <Row setting="storage.binDays" label="Keep what is in the bin" help={SETTING_HELP.binDays}>
            <Segmented oneLine label="Keep what is in the bin" value={String(binDays)} options={BIN_FOR} onChange={(v) => keepFor.mutate({ binDays: Number(v) as 0 | 7 | 30 })} />
          </Row>
          <Row setting="storage.jobDays" label="Keep finished jobs" help={SETTING_HELP.jobHistoryDays}>
            <Segmented oneLine label="Keep finished jobs" value={String(jobDays)} options={jobsFor(jobDays)} onChange={(v) => keepFor.mutate({ jobHistoryDays: Number(v) })} />
          </Row>
          {binFailed && <Block><Failed what={binFailed.what} error={binFailed.error} /></Block>}
          {empty.data?.inUse ? <Block className="text-xs text-ink-2">{plural(empty.data.inUse, "item")} {verb(empty.data.inUse, "was", "were")} left in the bin: a timeline, a person or a waiting job still uses {verb(empty.data.inUse, "it", "them")}.</Block> : null}
        </Card>
      </div>
      <div className="flex flex-col gap-4">
        <Backup />
        <RenderRecord />
      </div>
    </div>
  );
}

/** One zip of everything Afflatus keeps, made while it runs: the database and every file. */
function Backup() {
  // a key of its own, outside "storage": the library's events refresh that one, and the plan is a walk of every file (the server counts them once a minute)
  const plan = useQuery({ queryKey: queryKeys.backupPlan(), queryFn: api.backupPlan, staleTime: 60_000 });
  const p = plan.data;
  if (p && !p.available) return null;
  return (
    <Card title="Backup">
      <Row
        setting="storage.backup"
        label="Back up now"
        sub={p ? `${plural(p.files, "file")}${p.database ? " and the database" : ""}` : undefined}
        help={`One zip, made while Afflatus runs: ${p?.database ? "the database (a consistent copy) and " : ""}every file of the library. Not in it: the files of linked folders, which stay on your disk, and ComfyUI's models. To restore, stop Afflatus, unpack the zip into an empty data folder (pnpm restore <zip> <folder> does it, and refuses a folder that is not empty), and start it again with DATA_DIR pointing there.${p && !p.database ? " With Postgres, back the database up with Postgres's own tools." : " The keys and tokens of the settings (RunPod, Civitai, Hugging Face, the LLMs, the ComfyUI locks, Telegram, Discord) are left out: enter them again after a restore."}`}
      >
        <ButtonLink href="/api/backup.zip" download size="sm">Back up now{p ? ` · about ${size(p.bytes)}` : ""}</ButtonLink>
      </Row>
      {p?.withSecrets && (
        <Row
          label="With keys"
          help="The same zip with the keys and tokens of the settings in it: the RunPod key spends your money, a lock token opens its ComfyUI. Keep that file where only you can reach it. Made on the computer Afflatus runs on only."
        >
          <ButtonLink href="/api/backup.zip?secrets=1" download size="sm">Back up with keys</ButtonLink>
        </Row>
      )}
    </Card>
  );
}

/** The choices of the two rules that act on their own (the server takes these and no others). */
const UNKEPT_FOR = [{ value: "1", label: "1 day" }, { value: "3", label: "3 days" }, { value: "7", label: "A week" }, { value: "0", label: "Never" }];
const BIN_FOR = [{ value: "7", label: "A week" }, { value: "30", label: "30 days" }, { value: "0", label: "Until emptied" }];

/** How long finished jobs are kept: the server takes any number of days, so one set another way is shown among them. */
const JOB_DAYS = [7, 30, 90, 365];
const jobsFor = (days: number) => [...new Set([...JOB_DAYS, ...(days > 0 ? [days] : [])])].sort((a, b) => a - b)
  .map((n) => ({ value: String(n), label: n === 7 ? "A week" : n === 365 ? "A year" : plural(n, "day") }))
  .concat({ value: "0", label: "For good" });

const KEEP_FOR = [{ value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "365", label: "A year" }, { value: "0", label: "For good" }];

/** The record of render times (Queue, "Render times"): how long each render is kept one by one, how much room it takes, and a way to forget it. */
function RenderRecord() {
  const client = useQueryClient();
  const settings = useSettings();
  const record = useQuery({ queryKey: queryKeys.renders.size(), queryFn: api.renderRecordSize });
  const forget = useMutation({ mutationFn: api.clearRenderRecord, onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.renders.all() }) });
  const keep = useMutation({ mutationFn: (days: number) => api.saveSettings({ renderHistoryDays: days }), onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved) });
  const timesFailed = firstFailed([["Render times not forgotten", forget], ["Not saved", keep]]);
  const r = record.data;
  const days = settings.data?.renderHistoryDays ?? 90;
  return (
    <Card title="Render times" status={r && <span className="font-mono text-xs text-ink-3">{size(r.bytes)}</span>}>
      <Row
        setting="storage.renderTimes"
        label="Render times kept for"
        sub={r ? `${plural(r.renders, "render")} one by one${r.days ? `, ${plural(r.days, "day")} as figures` : ""}` : undefined}
        help={SETTING_HELP.renderHistoryDays}
      >
        <Segmented oneLine label="How long each render is kept one by one" value={String(days)} options={KEEP_FOR} onChange={(v) => keep.mutate(Number(v))} />
      </Row>
      <Row setting="storage.forgetTimes" label="Forget every render time" help="The estimates start again from nothing.">
        <TwoStep label="Forget every render time" tone="danger" title="Forget every render time" note="The estimates start again from nothing." yes="Forget them" busy={forget.isPending} disabled={!r || (!r.renders && !r.days)} onYes={() => forget.mutate()} />
      </Row>
      {timesFailed && <Block><Failed what={timesFailed.what} error={timesFailed.error} /></Block>}
    </Card>
  );
}
