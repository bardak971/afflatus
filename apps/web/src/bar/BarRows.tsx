import type { ReactNode } from "react";
import {
  Bookmark, Calculator, Film, Folder, FolderKanban, Image as ImageIcon, Keyboard, ListOrdered, MapPin, Music, Navigation, PenLine, Puzzle, Quote, SlidersHorizontal, Sparkles, User, Video, Workflow, Zap,
} from "lucide-react";
import { stepRateSaid, useStepRate } from "../screens/queue/stepRate";
import { cx } from "../ui";
import { Keys } from "../Keys";
import type { Item, Kind, Section } from "./items";
import { pieces } from "./match";
import type { Mode } from "./parse";
import type { SettingCtx } from "./settingsRegistry";
import type { Action } from "./actions/ctx";

/** Each kind's icon and the colour of its tile. */
const TONE: Record<Kind, string> = {
  timeline: "text-warn", render: "text-picture", draft: "text-accent", project: "text-accent", folder: "text-picture", command: "text-warn-ink",
  setting: "text-ink-2", job: "text-good", calc: "text-good", history: "text-ink-2", person: "text-accent",
  workflow: "text-picture", kit: "text-accent", nav: "text-ink-2", key: "text-ink-2",
};
const KIT_ICON = { person: User, place: MapPin, style: Sparkles, preset: Bookmark, snippet: Puzzle } as const;
function iconOf(it: Item): ReactNode {
  const s = 16;
  switch (it.kind) {
    case "timeline": return <Film size={s} />;
    case "render": return it.entry?.kind === "asset" && it.entry.assetKind === "video" ? <Video size={s} /> : it.entry?.kind === "asset" && it.entry.assetKind === "audio" ? <Music size={s} /> : <ImageIcon size={s} />;
    case "draft": return <PenLine size={s} />;
    case "project": return <FolderKanban size={s} />;
    case "folder": return <Folder size={s} />;
    case "command": return <Zap size={s} />;
    case "setting": return <SlidersHorizontal size={s} />;
    case "job": return <ListOrdered size={s} />;
    case "calc": return <Calculator size={s} />;
    case "history": return <Quote size={s} />;
    case "person": return <User size={s} />;
    case "workflow": return <Workflow size={s} />;
    case "kit": {
      const Icon = KIT_ICON[it.entry?.kind === "kit" ? it.entry.entity : "person"];
      return <Icon size={s} />;
    }
    case "nav": return <Navigation size={s} />;
    case "key": return <Keyboard size={s} />;
  }
}

/** The running render's s/it, after its row's detail: its own subscription, so that only it draws again at each step. */
function StepRateSaid({ id }: { id: string }) {
  const rate = useStepRate();
  return rate && rate.id === id ? <> · {stepRateSaid(rate.secondsPerStep)}</> : null;
}

/** The id of the row `i` of the list, for the input's aria-activedescendant. */
export const optionId = (i: number) => `bar-opt-${i}`;

/**
 * What the bar's list holds: the selected result's actions (Tab), the calculator's cards, or the results in their
 * sections; and what it says when there is nothing.
 */
export function BarRows({ acting, actions, shownActions, mode, text, sections, flat, at, off, settingCtx, reading, looking, onSelect, onActSelect, onChoose, onRun, onType }: {
  acting: { item: Item; sel: number } | null;
  /** The acted-on result's actions, and those its filter shows. */
  actions: Action[];
  shownActions: Action[];
  mode: Mode;
  text: string;
  sections: Section[];
  /** The sections' rows in one list, as the keys walk them. */
  flat: Section["rows"];
  /** The selected row. */
  at: number;
  /** Why the selected row's first action cannot run now, if it cannot. */
  off: string | null;
  settingCtx: SettingCtx;
  /** The index is being read for the first time; the prompt history is being searched. */
  reading: boolean;
  looking: boolean;
  onSelect(i: number): void;
  onActSelect(i: number): void;
  /** A row clicked: chosen as Enter would. */
  onChoose(it: Item, i: number): void;
  /** An action clicked. */
  onRun(a: Action): void;
  /** A calculator example clicked: written in the bar. */
  onType(typed: string): void;
}) {
  const empty = !acting && !flat.length;
  return (
    <>
      {acting ? (
        <>
          <div className="px-3 pt-2.5 pb-1.5 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Actions</div>
          {shownActions.map((a, i) => {
            // Enter and Ctrl+Enter on the result run the list's first two actions, wherever a filter shows them
            const place = actions.indexOf(a);
            return (
            <button
              key={`${a.label}:${i}`}
              id={optionId(i)}
              data-row={i}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={i === acting.sel}
              aria-disabled={a.disabled}
              onMouseMove={() => i !== acting.sel && onActSelect(i)}
              onClick={() => onRun(a)}
              className={cx("flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left", i === acting.sel && "bg-accent/14 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]", a.disabled && "opacity-45")}
            >
              <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-raised", a.danger ? "text-warn-ink" : "text-ink-2")}>{a.icon ?? <Zap size={15} />}</span>
              <span className="flex min-w-0 grow flex-col">
                <span className={cx("truncate text-[14.5px] font-semibold", a.danger ? "text-warn-ink" : "text-ink")}>{a.label}</span>
                {(a.note || place < 2) && <span className="truncate text-xs text-ink-2">{[a.note, place === 0 ? "Enter on the result" : place === 1 ? "Ctrl+Enter on the result" : ""].filter(Boolean).join(" · ")}</span>}
              </span>
              {a.keys && <Keys keys={a.keys} size="sm" className="text-ink-2" />}
              {i === acting.sel && <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-2"><Keys keys="Enter" size="sm" /> run</span>}
            </button>
            );
          })}
          {!shownActions.length && <div className="px-5 py-10 text-center text-sm text-ink-3">No action called that.</div>}
        </>
      ) : mode === "calc" ? (
        <div className="flex flex-col gap-3 p-2.5">
          {flat.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
              {flat.map((it, i) => (
                <button
                  key={it.key}
                  id={optionId(i)}
                  data-row={i}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === at}
                  onMouseMove={() => i !== at && onSelect(i)}
                  onClick={() => onChoose(it, i)}
                  className={cx("flex flex-col gap-1 rounded-xl p-3.5 text-left", i === at ? "bg-good/10 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-good)_40%,transparent)]" : "bg-raised/60")}
                >
                  <span className="text-xs text-ink-2">{it.card!.label}</span>
                  <span className="font-mono text-[26px] leading-tight font-medium text-ink-strong">{it.card!.value}</span>
                  <span className="text-[11.5px] text-ink-2">{it.card!.note}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-3 py-6 text-center text-sm text-ink-3">{text ? "The calculator does not read that." : "A length, frames, a size, proportions, or a sum."}</div>
          )}
          <div className="flex flex-wrap gap-2 font-mono text-xs text-ink-2">
            {["7s 24fps", "121f 24fps", "1152x2048", "9:16 1mp", "17*10+5"].map((x) => (
              <button key={x} type="button" tabIndex={-1} onClick={() => onType(`= ${x}`)} className="rounded-[7px] bg-raised px-2 py-1 hover:text-ink">{x}</button>
            ))}
          </div>
        </div>
      ) : (
        sections.map((s) => {
          const first = flat.indexOf(s.rows[0]!);
          return (
            <div key={s.group} role="group" aria-label={s.group}>
              <div className="px-3 pt-2.5 pb-1.5 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{s.group}</div>
              {s.rows.map((it, k) => {
                const i = first + k;
                const on = i === at;
                const toggle = it.setting?.kind === "switch" ? Boolean(it.setting.get?.(settingCtx)) : null;
                const running = it.job?.state === "running" ? (it.job.job as { progress?: number }).progress ?? 0 : null;
                return (
                  <button
                    key={it.key}
                    id={optionId(i)}
                    data-row={i}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={on}
                    onMouseMove={() => !on && onSelect(i)}
                    onClick={() => onChoose(it, i)}
                    className={cx("flex w-full items-center gap-3 rounded-[10px] px-3 py-[9px] text-left", on && "bg-accent/14 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]")}
                  >
                    <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[color-mix(in_srgb,currentColor_13%,transparent)]", it.job?.state === "failed" ? "text-warn" : TONE[it.kind])}>{iconOf(it)}</span>
                    <span className="flex min-w-0 grow flex-col gap-px">
                      <span className={cx("truncate text-[14.5px] font-semibold", it.job?.state === "failed" ? "text-warn-ink" : "text-ink", it.archived && "opacity-60")}>
                        {pieces(it.label, it.ranges ?? []).map((p, n) => (p.hit ? <span key={n} className="text-accent">{p.text}</span> : <span key={n}>{p.text}</span>))}
                      </span>
                      {running !== null && <span className="my-1 block h-1 overflow-hidden rounded-full bg-raised"><span className="block h-full rounded-full bg-good transition-[width] duration-500" style={{ width: `${Math.round(running * 100)}%` }} /></span>}
                      <span className="truncate text-xs text-ink-2">{it.meta}{it.job?.state === "running" && <StepRateSaid id={it.job.job.id} />}</span>
                    </span>
                    {toggle !== null && (
                      <span aria-hidden className={cx("h-5 w-[34px] shrink-0 rounded-full p-[3px] transition-colors", toggle ? "bg-accent" : "bg-line-strong")}>
                        <span className={cx("block h-3.5 w-3.5 rounded-full transition-[margin] duration-150", toggle ? "ml-[14px] bg-knob" : "bg-ink")} />
                      </span>
                    )}
                    {/* the key that does the same in the app, from the key table (a row of the `?` mode: its own keys, a search's lit) */}
                    {it.keys && <Keys keys={it.keys} size="sm" hits={it.keyRow?.hits} className="text-ink-2" />}
                    {on && <span className="flex shrink-0 items-center gap-1 text-[11px] whitespace-nowrap text-ink-2"><Keys keys="Enter" size="sm" /> {it.complete ? "complete" : off ? "unavailable" : it.verb}</span>}
                  </button>
                );
              })}
            </div>
          );
        })
      )}
      {empty && mode !== "calc" && (
        <div className="px-5 py-10 text-center text-sm text-ink-3">
          {reading ? "Reading what Afflatus holds…"
            : mode === "command" ? <>No command reads that. Try <span className="font-mono text-ink-2">render clips 3-5</span>, <span className="font-mono text-ink-2">seed 1234</span>, <span className="font-mono text-ink-2">pause queue</span>.</>
            : mode === "queue" ? "Nothing runs, waits or failed lately."
            : mode === "history" ? (looking ? "Looking…" : "No rendered prompt holds that.")
            : mode === "cast" ? "No person of the Prompt kit is called that."
            : mode === "keys" ? <>No key does that. Try another word, or a key: <Keys keys="S" size="sm" />, <Keys keys="Ctrl+Z" size="sm" />.</>
            : <>{text ? "Nothing called that." : "Nothing used or made yet."} Try <Keys keys=">" size="sm" /> for commands.</>}
        </div>
      )}
    </>
  );
}
