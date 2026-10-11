import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Film, LayoutGrid, ListOrdered, Settings2, Users, Workflow } from "lucide-react";
import { ProjectSwitch } from "./Projects";
import { useQueueOf } from "./screens/studio/queueOf";
import { MARK } from "./logo";
import { ThemeFlip } from "./theme/Appearance";
import { cx } from "./ui";
import { newsOf, useUpdates, useUpdatesSeen } from "./updates";

type Entry = { href: string; label: string; icon: ReactNode };

const NAV: Entry[] = [
  { href: "/", label: "Studio", icon: <LayoutGrid size={19} /> },
  { href: "/timelines", label: "Timelines", icon: <Film size={19} /> },
  { href: "/kit", label: "Prompt kit", icon: <Users size={19} /> },
  { href: "/workflows", label: "Workflows", icon: <Workflow size={19} /> },
];
const QUEUE: Entry = { href: "/queue", label: "Queue", icon: <ListOrdered size={18} /> };
const SETTINGS: Entry = { href: "/settings", label: "Settings", icon: <Settings2 size={19} /> };

/** The ring round the Queue's icon: r 13 in a 30 box. */
const RING = 2 * Math.PI * 13;

/** The app's mark: a breath (afflatus) drawn in one stroke, on the accent. */
function Mark() {
  return (
    <span
      role="img"
      aria-label="Afflatus"
      data-tip="Afflatus"
      // on the dark of the stage in every theme, as the favicon: the accent there is the one tuned for the dark
      data-stage
      className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] border border-line bg-raised"
    >
      <svg width="27" height="27" viewBox="0 0 100 100" className="text-accent" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" fillRule="evenodd" aria-hidden>
        <path d={MARK.body} />
        <path d={MARK.spark} />
      </svg>
    </span>
  );
}

/** One way to a screen: its icon in a pill, its name under it. `pill` is drawn over the pill (the Queue's ring), `badge` at its corner. */
function Item({ entry, path, tip, label, pill, badge }: { entry: Entry; path: string; tip?: string; label?: string; pill?: ReactNode; badge?: ReactNode }) {
  const on = entry.href === "/" ? path === "/" || path === "/create" : path.startsWith(entry.href);
  return (
    <Link
      href={entry.href}
      aria-current={on ? "page" : undefined}
      aria-label={label}
      data-tip={tip}
      className={cx("group relative flex w-[62px] shrink-0 flex-col items-center gap-1 rounded-[12px] pt-1.5 pb-[7px] text-[10.5px] font-semibold", on ? "text-ink" : "text-ink-2 hover:text-ink")}
    >
      <span className={cx("relative flex h-[30px] w-12 items-center justify-center rounded-full", on ? "bg-accent/18 text-accent" : "group-hover:bg-hover")}>
        {pill}
        {entry.icon}
      </span>
      {entry.label}
      {badge}
    </Link>
  );
}

/** The Queue, alive in the rail: the running job as a ring round its icon, the waiting ones counted at its corner. */
function QueueItem({ path }: { path: string }) {
  // only these figures: the rail draws again when they move, not at every change of the queue
  const q = useQueueOf((s) => ({ running: s.running ? { label: s.running.label, progress: s.running.progress } : null, waiting: s.waiting.length }));
  const running = q?.running ?? null;
  const waiting = q?.waiting ?? 0;
  const parts = [running && `rendering ${running.label}`, waiting > 0 && `${waiting} waiting`].filter(Boolean);
  const tip = parts.length ? `Queue · ${parts.join(" · ")}` : undefined;
  const done = running ? Math.min(1, Math.max(0, running.progress)) : 0;
  return (
    <Item
      entry={QUEUE}
      path={path}
      tip={tip}
      label={tip}
      pill={
        running && (
          <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden className={cx("absolute", done === 0 && "animate-spin [animation-duration:2.4s] motion-reduce:animate-none")}>
            <circle cx="15" cy="15" r="13" fill="none" stroke="var(--color-line-strong)" strokeWidth="2" />
            {/* no figure yet from this phase: a quarter that turns slowly */}
            <circle
              cx="15"
              cy="15"
              r="13"
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={RING}
              strokeDashoffset={done > 0 ? RING * (1 - done) : RING * 0.75}
              transform="rotate(-90 15 15)"
              className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
            />
          </svg>
        )
      }
      badge={
        waiting > 0 && (
          <span aria-hidden className="absolute top-0.5 right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 font-mono text-[9.5px] font-extrabold text-accent-ink">
            {waiting}
          </span>
        )
      }
    />
  );
}

/**
 * Settings, with a dot when a new Afflatus is out that this browser has not seen in Settings → About yet: quiet, nothing
 * moves on the page, and it sits one click from the Update button. Its tip names the version.
 */
function SettingsItem({ path }: { path: string }) {
  const updates = useUpdates();
  const seen = useUpdatesSeen((s) => s.seen);
  const news = newsOf(updates.data, seen);
  const tip = news ? `Settings · Afflatus ${news} is out` : undefined;
  return (
    <Item
      entry={SETTINGS}
      path={path}
      tip={tip}
      label={tip}
      badge={news && <span aria-hidden data-news="" className="absolute top-[5px] right-[9px] h-[9px] w-[9px] rounded-full bg-accent ring-2 ring-panel" />}
    />
  );
}

/** The rail at the left of every screen: the mark, the project worked in, the screens, then Settings and the theme at the foot. */
export function NavRail() {
  const [path] = useLocation();
  return (
    <nav aria-label="Main" className="flex w-[76px] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line bg-panel pt-3.5 pb-3 [scrollbar-width:none]">
      <Mark />
      <ProjectSwitch />
      <span aria-hidden className="my-1.5 h-px w-9 shrink-0 bg-line" />
      {NAV.map((n) => <Item key={n.href} entry={n} path={path} />)}
      <QueueItem path={path} />
      <span className="grow" />
      <SettingsItem path={path} />
      <ThemeFlip />
    </nav>
  );
}
