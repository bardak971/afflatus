import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronRight, Film, PenLine, Zap } from "lucide-react";
import { api, type CostsView, type PodSession, type ProjectCost, type RenderCostRow } from "../../api";
import { Dialog, DialogHead } from "../../Dialog";
import { dayMonth, est, gb, hourMinute, long, plural, spell, usd, UI_LOCALE } from "../../format";
import { useProject } from "../../project";
import { Initial, projectTone } from "../../projects/tone";
import { queryKeys } from "../../queryKeys";
import { useOpenDraft, useStudio } from "../../store";
import { Button, cx, ErrorNote, Help } from "../../ui";
import { KwhForm } from "../settings/ElectricityCard";
import { settingHref } from "../settings/settingsIndex";
import { TimeChart, useChartColors } from "./Chart";
import { BOOT_SAID, bootSaid, bootSplit, COST_PRESETS, lowerFirst, NOT_SPLIT, nothingShare, PART_SAID, presetWindow, runwayNowSaid, runwaySaid, runwayWhy, sessionBits, totalMs, totalsSaid } from "./costsView";
import { chartTimeLabel, stretchOf, type View } from "./useTimesView";
import { WindowBar } from "./WindowBar";

/**
 * Queue › Costs: what the rented GPUs cost and where it went, what a render costs where it runs, what would cost less, and
 * this PC's electricity. One call for all of it (GET /api/costs, the server's costs.ts), over the window picked or dragged
 * on the chart, as Render times has it.
 */

const CARD = "flex min-w-0 flex-col gap-3 rounded-[14px] border border-line bg-panel p-[18px]";

function Head({ title, note, help, children }: { title: string; note?: ReactNode; help?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <h3 className="text-[15px] font-bold">{title}</h3>
      {help && <Help text={help} title={title} className="self-center" />}
      {note && <span className="text-[12.5px] text-ink-2">{note}</span>}
      {children && <span className="grow" />}
      {children}
    </div>
  );
}

function Tile({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[14px] border border-line bg-panel p-4">
      <span className="truncate text-[11.5px] font-semibold tracking-[0.05em] text-ink-3 uppercase">{label}</span>
      <span className="font-mono text-[28px] leading-tight font-bold">{value}</span>
      {children}
    </div>
  );
}

const capsLink = <Link href={settingHref("comfy.rentcaps")} className="text-accent hover:underline">set caps</Link>;

function TopFigures({ d }: { d: CostsView }) {
  const monthName = new Date(d.to).toLocaleDateString(UI_LOCALE, { month: "long" });
  const share = d.caps.month > 0 ? d.month / d.caps.month : null;
  const s = d.storage;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
      <Tile label={monthName} value={usd(d.month)}>
        {share !== null && (
          <span className="h-[5px] overflow-hidden rounded-full bg-line">
            <span className={cx("block h-full rounded-full", share >= 0.9 ? "bg-warn" : "bg-accent")} style={{ width: `${Math.min(100, share * 100)}%` }} />
          </span>
        )}
        <span className="text-xs text-ink-2">{share !== null ? <>{Math.round(share * 100)} % of a {usd(d.caps.month)} cap · {capsLink}</> : <>no cap · {capsLink}</>}</span>
        {Math.abs(d.notSplit) >= 0.01 && (
          <span className="flex items-center gap-1 text-xs text-ink-2">
            {d.notSplit > 0 ? `${usd(d.notSplit)} of it not split` : `${usd(-d.notSplit)} under Afflatus's count`}
            <Help text={d.notSplit > 0 ? `RunPod's bill this month, less Afflatus's count of the pods' time at their rates (what Where it went and the chart split, over the month): pods not added to Afflatus, stopped pods' disks, the bill's rounding. The chart shows it per ${stretchOf(d.step)} as Not split.` : "RunPod billed less than Afflatus counted (a run that ended while Afflatus was away is counted to the latest it could have run). The bill is the reference."} />
          </span>
        )}
      </Tile>
      <Tile label="Today" value={usd(d.today.usd)}>
        <span className="text-xs text-ink-2">{d.today.sessions ? `${plural(d.today.sessions, "pod session")} · ${long(d.today.ms)}` : "no pod session"}</span>
      </Tile>
      <Tile label="Month end, at this pace" value={`~${usd(d.monthEnd)}`}>
        <span className="flex items-center gap-1 text-xs text-ink-2">
          from the last 7 days
          <Help text={`This month so far with the volumes' bill, plus ${usd(d.pace7 + d.storageDay)} a day until its end: the pods' last 7 days (${usd(d.pace7)} a day, Afflatus's count) and storage as it stands (${usd(d.storageDay)} a day).`} />
        </span>
      </Tile>
      <Tile label="RunPod balance" value={d.balance === null ? "—" : usd(d.balance)}>
        <span className="flex items-center gap-1 text-xs text-ink-2">
          {d.balance === null ? (d.runpod ? "RunPod did not say" : "no RunPod key") : [runwaySaid(d.runwayDays), runwayNowSaid({ spendPerHr: d.spendPerHr, runwayNowMs: d.runwayNowMs, perDay: d.pace7 + d.storageDay })].filter(Boolean).join(" · ")}
          {d.balance !== null && <Help text={runwayWhy({ pods: d.pace7, storage: d.storageDay })} />}
        </span>
      </Tile>
      <Tile label="Billed while you sleep" value={s ? <>{usd(s.perMonth)}<span className="text-sm text-ink-3">/month</span></> : "—"}>
        <span className="flex items-center gap-1 text-xs text-ink-2">
          {!s ? "RunPod not read" : s.volumes || s.stoppedDisks ? [s.volumes ? plural(s.volumes, "volume") : "", s.stoppedDisks ? plural(s.stoppedDisks, "stopped pod") : ""].filter(Boolean).join(" · ") : "no volume, no stopped pod"}
          <Help text="Network volumes and the disks of stopped pods bill every month whether anything runs or not. Settings › Rented GPUs lists them." />
        </span>
      </Tile>
    </div>
  );
}

function WhereItWent({ d }: { d: CostsView }) {
  const all = totalMs(d.where.ms);
  const money = Object.values(d.where.usd).reduce((n, v) => n + v, 0);
  // Booting in its parts, in its place in the bar and under its legend, where any boot of the window was kept in parts
  const boots = bootSplit(d.where.boot.ms);
  if (!all) return null;
  return (
    <section className={CARD} aria-label="Where it went">
      <Head
        title="Where it went" note={`${long(all)} of pod time, ${usd(money)}`}
        help="Each pod's time from its deploy (or Start) to its end, cut into what it did: rendering, booting until its ComfyUI first answered, fetching model files, idle (waiting for work, or for its idle time to stop it), and renders that failed or were cancelled. RunPod bills all of it."
      >
        <span className="flex items-center gap-1 text-[12.5px] text-warn-ink">
          {Math.round(nothingShare(d.where.usd) * 100)} % of it made nothing
          <Help text="All but the renders that finished: booting, fetching files, idle and failed renders. Some of it cannot be helped (a pod boots before it renders); What would cost less says what can." />
        </span>
      </Head>
      <div className="flex h-7 gap-0.5 overflow-hidden rounded-lg">
        {PART_SAID.filter((p) => d.where.usd[p.part] > 0).flatMap((p) =>
          p.part === "boot" && boots.length
            ? boots.map((b) => <span key={`boot-${b.part}`} data-tip={`Booting, ${lowerFirst(b.name)}: ${usd(d.where.boot.usd[b.part])} · ${long(d.where.boot.ms[b.part])}`} className="min-w-[3px]" style={{ flexGrow: d.where.boot.usd[b.part], background: b.color }} />)
            : [<span key={p.part} data-tip={`${p.name}: ${usd(d.where.usd[p.part])} · ${long(d.where.ms[p.part])}`} className="min-w-[3px]" style={{ flexGrow: d.where.usd[p.part], background: p.color }} />],
        )}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {PART_SAID.map((p) => (
          <span key={p.part} className="flex items-center gap-2 text-[12.5px]">
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: p.color }} />
            <span className="font-semibold">{p.name}</span>
            <span className="font-mono text-ink-2">{usd(d.where.usd[p.part])} · {long(d.where.ms[p.part])}</span>
          </span>
        ))}
        {d.where.estimated && (
          <span className="flex items-center gap-1 text-xs text-ink-3">
            older sessions estimated
            <Help text="Sessions before this version kept no first answer of their ComfyUI nor their files one by one: their boot ends at their boot measure or their first work, and their files are those over 100 MB, from their speed. Each session's tip says what was worked out." />
          </span>
        )}
      </div>
      {boots.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <span className="flex items-center gap-1 text-ink-3">
            Booting:
            <Help
              title="Booting, in its parts"
              text="Pulling the image: from the deploy (or Start) until RunPod says its container is up; a host new to the image pulls it for minutes. Node packs: the Afflatus image's boot log, from putting in the node packs until its next step: the packs on the volume get their Python packages installed at every start. Starting ComfyUI: the rest, until ComfyUI first answered. Failed starts: the boots that never came up (a step that failed, a GPU that did not work, no answer by the boot limit), from their container's start to their end. Not split: boots before this version, and parts no boot log said."
            />
          </span>
          {boots.map((b) => (
            <span key={b.part} className="flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-[3px]" style={{ background: b.color }} />
              <span className="text-ink-2">{b.name}</span>
              <span className="font-mono text-ink-2">{usd(d.where.boot.usd[b.part])} · {long(d.where.boot.ms[b.part])}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function SpendChart({ d, onZoom }: { d: CostsView; onZoom(from: number, to: number): void }) {
  const tones = useChartColors();
  const stretch = stretchOf(d.step);
  const dayCap = d.step >= 86_400_000 && d.caps.day > 0 ? { value: d.caps.day, label: `day cap ${usd(d.caps.day)}` } : null;
  return (
    <TimeChart
      title={`Spend per ${stretch}`} note="by GPU · drag: zoom" times={d.times} step={d.step} timeLabel={chartTimeLabel(d.to - d.from, d.step)} onBrush={onZoom}
      format={(v) => usd(v, true)} axisFormat={(v) => usd(v)} stacked bars stat="sum" height={210} rule={dayCap}
      series={d.spend.gpus.map((g, i) => ({ name: g, values: d.spend.values[i]!, color: g === NOT_SPLIT ? "var(--color-line-strong)" : g === "Other" ? "var(--color-ink-3)" : tones[i % tones.length] }))}
    />
  );
}

function ProjectRow({ p, most }: { p: ProjectCost; most: number }) {
  const [open, setOpen] = useState(false);
  const [, go] = useLocation();
  const tone = p.id === null ? "var(--color-ink-2)" : projectTone(p.id);
  const what = p.renders ? [p.timelines ? plural(p.timelines, "timeline") : "", p.drafts ? plural(p.drafts, "draft") : "", plural(p.renders, "render")].filter(Boolean).join(" · ") : "no render on a pod in this window";
  // an item of another project is shown where it lives: working in that project, as the command bar opens one
  const into = () => {
    if (useProject.getState().id !== (p.id ?? "none")) useProject.getState().set(p.id ?? "none");
  };
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button" disabled={!p.items.length} onClick={() => setOpen(!open)} aria-expanded={open}
        className="grid grid-cols-[16px_26px_minmax(0,1fr)_minmax(60px,140px)_64px] items-center gap-2.5 rounded-[10px] bg-hover/60 px-2.5 py-2 text-left enabled:hover:bg-hover"
      >
        <ChevronRight size={14} className={cx("text-ink-2 transition-transform", open && "rotate-90", !p.items.length && "opacity-0")} />
        <span className="flex size-[26px] items-center justify-center rounded-[7px] border-[1.5px] text-xs font-extrabold" style={{ borderColor: tone, color: tone }}>
          <Initial name={p.name} inbox={p.id === null} size={13} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] font-semibold">{p.name}</span>
          <span className="truncate text-xs text-ink-2">{p.id === null && p.renders ? `in no project · ${what}` : what}</span>
        </span>
        <span className="h-1.5 overflow-hidden rounded-full bg-line"><span className="block h-full rounded-full bg-accent" style={{ width: `${most > 0 ? (p.usd / most) * 100 : 0}%` }} /></span>
        <span className="text-right font-mono text-[13px]">{p.usd > 0 && p.usd < 0.01 ? "<$0.01" : usd(p.usd)}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 pl-[52px]">
          {p.items.map((i) => (
            <button
              key={i.id} type="button"
              data-tip={i.kind === "timeline" ? "Open the timeline" : "Open the draft"}
              onClick={() => {
                into();
                if (i.kind === "timeline") go(`/timelines/${i.id}`);
                else {
                  useOpenDraft.getState().open(i.id);
                  useStudio.getState().set({ form: true, scope: "draft" });
                  go("/");
                }
              }}
              className="grid grid-cols-[18px_minmax(0,1fr)_64px] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover"
            >
              <span className="text-ink-3">{i.kind === "timeline" ? <Film size={13} /> : <PenLine size={13} />}</span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[13px]">{i.name}</span>
                <span className="truncate text-[11.5px] text-ink-3">{plural(i.renders, "render")} · {i.models.join(", ")}</span>
              </span>
              <span className="text-right font-mono text-[12.5px] text-ink-2">{i.usd < 0.01 ? "<$0.01" : usd(i.usd)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ByProject({ d }: { d: CostsView }) {
  const most = Math.max(0, ...d.projects.map((p) => p.usd));
  return (
    <section className={CARD} aria-label="By project">
      <Head title="By project" note="renders only: a pod's waits are in Where it went" help="Each render on a pod at its pod's rate, under the project of its timeline or draft (the Inbox for those in none). Its boot, its files and its idle time are the pod's, not a render's." />
      {d.projects.length ? d.projects.map((p) => <ProjectRow key={p.id ?? "inbox"} p={p} most={most} />) : <span className="text-sm text-ink-3">No project yet.</span>}
    </section>
  );
}

function SessionRow({ s, longest, split }: { s: PodSession; longest: number; split: boolean }) {
  const [open, setOpen] = useState(false);
  const bits = sessionBits(s, longest, split);
  const boot = bootSaid(s);
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="grid grid-cols-[minmax(0,230px)_minmax(0,1fr)_64px] items-center gap-3.5 rounded-lg px-1.5 py-1 text-left hover:bg-hover">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-semibold">{s.gpu ?? "GPU"} <span className="font-normal text-ink-3">· ${s.rate.toFixed(2)}/h</span></span>
          <span className="truncate text-[11.5px] text-ink-3">{dayMonth(s.from)} {hourMinute(s.from)} · {s.open ? "running now" : s.startFailed ? "its start failed" : s.why}</span>
        </span>
        <span className="flex h-[18px] gap-0.5">
          {bits.map((b) => <span key={b.key} data-tip={b.tip} className="min-w-[3px] rounded" style={{ width: `${b.share * 100}%`, background: b.color }} />)}
        </span>
        <span className="text-right font-mono text-[13px]">{usd(s.usd)}</span>
      </button>
      {open && (
        <div className="mb-1 ml-1.5 flex flex-col gap-0.5 border-l border-line py-1 pl-3 text-xs">
          {s.estimated.length > 0 && <span className="text-ink-3">Estimated: {s.estimated.join("; ")}.</span>}
          {boot && <span className={cx(s.startFailed ? "text-warn-ink" : "text-ink-3")}>{boot}</span>}
          {s.renders.length ? s.renders.map((r) => (
            // the time's column holds the longest spell() gives on one line ("59 min 59 s"): at 64px it wrapped
            <span key={r.id} className="grid grid-cols-[48px_minmax(0,1fr)_88px_64px] items-center gap-2">
              <span className="font-mono text-ink-3">{hourMinute(r.at)}</span>
              <span className={cx("truncate", r.status !== "done" && "text-warn-ink")}>{r.model}{r.item ? ` · ${r.item.name}` : ""}{r.status !== "done" ? ` · ${r.status}` : ""}</span>
              <span className="text-right font-mono whitespace-nowrap text-ink-2">{spell(r.ms)}</span>
              <span className="text-right font-mono text-ink-2">{usd(r.usd, true)}</span>
            </span>
          )) : <span className="text-ink-3">No render on it{s.fetched.files ? `: it fetched ${plural(s.fetched.files, "file")} (${gb(s.fetched.bytes)})` : ""}.</span>}
        </div>
      )}
    </div>
  );
}

function Sessions({ d }: { d: CostsView }) {
  const [all, setAll] = useState(false);
  if (!d.sessions.length) return null;
  const longest = Math.max(...d.sessions.map((s) => s.to - s.from));
  const shown = all ? d.sessions : d.sessions.slice(0, 12);
  const split = bootSplit(d.where.boot.ms).length > 0;
  return (
    <section className={CARD} aria-label="Pod sessions">
      <Head title="Pod sessions" note="each from its deploy to its end, in what it did">
        <span className="text-xs text-ink-3">click: its renders</span>
      </Head>
      {shown.map((s) => <SessionRow key={s.id} s={s} longest={longest} split={split} />)}
      <span className="flex items-center gap-3 text-[11.5px] text-ink-3">
        Bars to one scale: the longest, {long(longest)}.
        {d.sessions.length > shown.length && <Button size="sm" onClick={() => setAll(true)}>Show all {d.sessions.length}</Button>}
      </span>
    </section>
  );
}

function costSaid(r: RenderCostRow, currency: string): string {
  if (r.where !== "home") return `${r.where === "guess" ? "~" : ""}${usd(r.usd ?? 0, true)}`;
  if (r.local !== null) return r.local < 0.001 ? `<${currency}0.001` : `${currency}${r.local < 0.01 ? r.local.toFixed(3) : r.local.toFixed(2)}`;
  return r.wh !== null ? `${r.wh.toFixed(1)} Wh` : "not known";
}

function RenderCosts({ d }: { d: CostsView }) {
  if (!d.renderCosts.length) return null;
  const price = d.kwh.price;
  return (
    <section className={CARD} aria-label="A render's cost">
      <Head title="A render's cost" note="p50 of your renders · the cheapest a model has, marked" />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,150px)_70px_60px_72px] gap-2.5 px-2.5 text-[11px] font-semibold tracking-[0.04em] text-ink-3 uppercase">
        <span>Model</span><span>On</span><span className="text-right">Time</span><span className="text-right">Renders</span><span className="text-right">Cost</span>
      </div>
      {d.renderCosts.map((r, i) => (
        <div key={`${r.key}-${r.where}-${r.on}-${i}`} className={cx("grid grid-cols-[minmax(0,1fr)_minmax(0,150px)_70px_60px_72px] items-center gap-2.5 rounded-[10px] px-2.5 py-2", r.best ? "bg-accent-wash" : "bg-hover/50")}>
          <span className="truncate text-[13px] font-semibold" data-tip={r.file || undefined}>
            {r.model}
            {/* one recipe on several model files: each row says its file */}
            {r.file && d.renderCosts.some((o) => o.model === r.model && o.key !== r.key) && <span className="ml-1.5 text-xs font-normal text-ink-3">{r.file}</span>}
          </span>
          <span className="truncate text-[12.5px] text-ink-2">
            {r.on}{r.where === "guess" && <span data-tip="Not rendered on yet: its time is the GPU hunt's guess from your renders on another GPU and a rough table of speeds. A guess until it renders."> (a guess)</span>}
          </span>
          <span className="text-right font-mono text-[12.5px]">{r.ms === null ? "—" : r.where === "guess" ? est(r.ms) : spell(r.ms)}</span>
          <span className="text-right font-mono text-[12.5px] text-ink-2">{r.renders || "—"}</span>
          <span
            className={cx("text-right font-mono text-[13px] font-semibold", r.where === "home" ? "text-warn-ink" : r.best ? "text-accent" : "")}
            data-tip={r.where === "home" && r.local === null ? (r.wh === null ? "Its GPU's power was never read: the Afflatus node pack 0.18.0 and newer reads it on an NVIDIA GPU." : "Set a price a kWh to see it in money.") : undefined}
          >
            {costSaid(r, d.kwh.currency)}
          </span>
        </div>
      ))}
      <span className="text-[11.5px] text-ink-3">
        {price !== null
          ? `"This PC": its electricity, GPU only, at ${d.kwh.currency}${price} a kWh (Settings). Not your hardware's wear, nor the rest of the PC.`
          : `"This PC": its GPU's energy a render; set a price a kWh (This PC, below) for its cost. Not your hardware's wear, nor the rest of the PC.`}
      </span>
    </section>
  );
}

function AdviceCard({ d }: { d: CostsView }) {
  const dot = (kind: string) => PART_SAID.find((p) => p.part === kind)?.color ?? BOOT_SAID.find((p) => p.part === kind)?.color ?? "var(--color-accent)";
  return (
    <section className={CARD} aria-label="What would cost less">
      <Head title="What would cost less" help="Fixed rules on this window's sessions and renders: the idle at the end of sessions against a shorter idle, the boots (the image pulled onto hosts new to it, the node packs' installs), the same files fetched on several deploys against a network volume, and the cheapest GPU per model." />
      {d.advice.length ? d.advice.map((a) => (
        <div key={a.title} className="flex gap-3 rounded-[11px] bg-hover/60 p-3">
          <span className="mt-[5px] size-2.5 shrink-0 rounded-full" style={{ background: dot(a.kind) }} />
          <span className="flex min-w-0 grow flex-col gap-1">
            <span className="text-[13.5px] font-semibold">{a.title}</span>
            <span className="text-[12.5px] text-ink-2">{a.why}</span>
          </span>
          {a.save !== null && <span className="shrink-0 font-mono text-[13px] font-semibold text-good">−{usd(a.save)}</span>}
        </div>
      )) : <span className="text-sm text-ink-3">Nothing to say for this window.</span>}
    </section>
  );
}

function ThisPc({ d }: { d: CostsView }) {
  const [asking, setAsking] = useState(false);
  const c = d.kwh.currency;
  return (
    <section className={CARD} aria-label="This PC">
      {d.home.length ? d.home.map((h) => (
        <div key={h.machine} className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-[14px] font-bold">{h.name}{h.gpu && h.gpu !== "GPU" ? ` · ${h.gpu}` : ""} <span className="font-normal text-ink-2">· {plural(h.renders, "render")}</span></span>
          <span className="flex items-center gap-1 text-[13px] text-ink-2">
            {h.read ? (
              <>
                GPU power read while it renders: <span className="font-mono text-ink">{(h.wh / 1000).toFixed(h.wh >= 10_000 ? 1 : 2)} kWh</span>
                {h.cost !== null && <> · <span className="font-mono text-ink">{c}{h.cost.toFixed(2)}</span> at {c}{d.kwh.price} a kWh</>}
                {h.avgW !== null && <> · avg {Math.round(h.avgW)} W</>}
                {h.read < h.renders && <span className="text-ink-3"> ({h.read} of its renders read)</span>}
              </>
            ) : (
              <>
                GPU power: not known
                <Help text="Read by the Afflatus node pack (0.18.0 and newer) while a render runs, through NVML or nvidia-smi on an NVIDIA GPU. Renders before it, and GPUs it cannot read, have none." />
              </>
            )}
          </span>
        </div>
      )) : <span className="text-sm text-ink-3">No render on this PC in this window.</span>}
      <div className="flex">
        <Button size="sm" onClick={() => setAsking(true)}><Zap size={13} /> Price a kWh…</Button>
      </div>
      {asking && (
        <Dialog label="Price a kWh" onClose={() => setAsking(false)}>
          <DialogHead icon={<Zap size={15} />} title="Price a kWh" sub="This PC's electricity, in your own money" onClose={() => setAsking(false)} />
          <p className="text-[13px] text-ink-2">Multiplied by the energy the GPU drew while each render ran. Empty: the energy alone.</p>
          <KwhForm onDone={() => setAsking(false)} />
        </Dialog>
      )}
    </section>
  );
}

/** The tab's window: a preset that ends now (the month from its 1st), or one typed or dragged on the chart. */
function useCostsView() {
  const [view, setView] = useState<View>({ preset: "30D" });
  const [typed, setTyped] = useState<{ from: string; to: string } | null>(null);
  const key = "from" in view ? `${Math.round(view.from)}-${Math.round(view.to)}` : view.preset;
  const costs = useQuery({
    queryKey: queryKeys.costs.of(key),
    queryFn: ({ signal }) => api.costs("from" in view ? { from: view.from, to: view.to } : presetWindow(view.preset), { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  return {
    view, typed, setTyped, costs,
    zoom: (from: number, to: number) => {
      setTyped(null);
      setView({ preset: "custom", from, to });
    },
    pick: (preset: string) => {
      setTyped(null);
      setView({ preset });
    },
  };
}

export function Costs() {
  const { view, typed, setTyped, costs, zoom, pick } = useCostsView();
  const d = costs.data;
  if (costs.isError) return <ErrorNote>{costs.error.message}</ErrorNote>;
  if (!d) return <div className="text-ink-2">Loading costs…</div>;
  const pods = d.runpod || d.sessions.length > 0;
  return (
    <div className="flex flex-col gap-4 pb-4">
      <div className="flex flex-wrap items-center gap-3">
        <WindowBar view={view} shown={{ from: d.from, to: d.to }} typed={typed} onTyped={setTyped} onPreset={pick} onZoom={zoom} presets={COST_PRESETS} />
      </div>
      <p className="-mt-1 text-xs text-ink-3">{totalsSaid(d)}</p>
      {pods && <TopFigures d={d} />}
      {pods && <WhereItWent d={d} />}
      {pods && (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <SpendChart d={d} onZoom={zoom} />
          <ByProject d={d} />
        </div>
      )}
      {pods && <Sessions d={d} />}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <RenderCosts d={d} />
        {pods && <AdviceCard d={d} />}
      </div>
      <ThisPc d={d} />
    </div>
  );
}
