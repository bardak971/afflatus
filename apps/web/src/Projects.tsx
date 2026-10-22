import { Suspense, useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { openProjects, type Reveal } from "./bar/bridge";
import { ArrowDown, ArrowUp, FolderKanban, LogIn, PinOff } from "lucide-react";
import type { Asset } from "./api";
import { useProjects } from "./data";
import { ContextMenu, useMenu } from "./ContextMenu";
import { useKeysHere } from "./keys/here";
import { useProject } from "./project";
import { usePins } from "./projects/pins";
import { Initial, projectTone } from "./projects/tone";
import { cx } from "./ui";
import { useFlip } from "./useFlip";
import { lazyPart, loadNewProject, loadProjectsPanel, loadViewer } from "./lazyParts";

// the panel loads on its first opening: it is not needed to draw the app
const ProjectsPanel = lazyPart(loadProjectsPanel, (m) => m.ProjectsPanel);
// the Viewer too: fetched the first time an item is opened from the panel (a lazy import is only that when no file
// loaded with the app imports the Viewer itself: the screens take it through viewer/LazyViewer.tsx)
const Viewer = lazyPart(loadViewer, (m) => m.Viewer);
// and the New project dialog
const NewProject = lazyPart(loadNewProject, (m) => m.NewProject);

/** The type of a pin dragged along the rail: only the rail's own pins take it. */
const DRAG_PIN = "application/x-afflatus-pin";

/**
 * The projects pinned to the rail, under the one worked in: one click works in each, the active one outlined. Dragged
 * along the rail they change places; they are pinned from the Projects panel's row menu, and a pin's own right-click
 * menu works in it, moves it and unpins it.
 */
function Pins({ current }: { current: string }) {
  const pins = usePins();
  const projects = useProjects();
  const set = useProject((s) => s.set);
  // where a dragged pin would land: before the pin at this index (the count: after the last)
  const [over, setOver] = useState<number | null>(null);
  const dragged = useRef<string | null>(null);
  // a pin moved (dropped, Alt + arrow) slides to its place and the others step aside; the order changes only on the
  // drop, so nothing moves under the browser's drag picture
  const flip = useFlip(pins.ids);
  const menu = useMenu<{ id: string; i: number }>();
  if (!pins.ids.length) return null;
  const nameOf = (id: string) => (id === "none" ? "Inbox" : projects.data?.items.find((p) => p.id === id)?.name ?? "…");
  const dragOver = (i: number, e: DragEvent) => {
    if (!dragged.current || !e.dataTransfer.types.includes(DRAG_PIN)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // the upper half of a square: before it; the lower half: after it
    const box = e.currentTarget.getBoundingClientRect();
    const at = e.clientY < box.top + box.height / 2 ? i : i + 1;
    if (over !== at) setOver(at);
  };
  const end = () => {
    dragged.current = null;
    setOver(null);
  };
  return (
    <div role="list" aria-label="Pinned projects" className="mt-0.5 flex shrink-0 flex-col items-center gap-1.5 border-y border-line px-3 py-2">
      {pins.ids.map((id, i) => {
        const on = id === current;
        const tone = id === "none" ? "var(--color-ink-2)" : projectTone(id);
        const name = nameOf(id);
        return (
          // a list item holding a real button: read as "button, 1 of 2" rather than a list item that happens to click
          <div key={id} ref={flip(id)} role="listitem">
          <button
            type="button"
            draggable
            aria-current={on ? "true" : undefined}
            aria-label={`${name} (pinned)`}
            data-tip-head={name}
            data-tip={on ? "Working in it. Drag, or Alt + ↑ ↓, to reorder the pins; right-click to unpin." : "Click to work in it. Drag, or Alt + ↑ ↓, to reorder the pins; right-click to unpin."}
            onClick={() => set(id)}
            onContextMenu={(e) => menu.open(e, { id, i })}
            // the keyboard's way to reorder, as form sections and a person's pictures: the pin keeps the focus as it moves
            onKeyDown={(e) => {
              if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
              e.preventDefault();
              if (e.key === "ArrowUp" && i > 0) pins.move(id, i - 1);
              if (e.key === "ArrowDown" && i < pins.ids.length - 1) pins.move(id, i + 2);
            }}
            onDragStart={(e) => {
              dragged.current = id;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData(DRAG_PIN, id);
            }}
            onDragOver={(e) => dragOver(i, e)}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragged.current;
              const at = over;
              end();
              if (from && at !== null) pins.move(from, at);
            }}
            onDragEnd={end}
            className={cx(
              "relative flex h-[30px] w-[30px] items-center justify-center rounded-lg border bg-hover text-body font-extrabold transition-[border-color,box-shadow] duration-150 motion-reduce:transition-none",
              on ? "border-[1.5px]" : "border-line-strong hover:border-ink-3",
              // the line a dragged pin lands on: above this square, or below the last one
              over === i && "before:absolute before:-top-[5px] before:h-0.5 before:w-7 before:rounded-full before:bg-accent",
              over === i + 1 && i === pins.ids.length - 1 && "after:absolute after:-bottom-[5px] after:h-0.5 after:w-7 after:rounded-full after:bg-accent",
            )}
            style={on ? { borderColor: tone, color: tone, boxShadow: `0 0 0 2px color-mix(in srgb, ${tone} 25%, transparent)` } : { color: tone }}
          >
            <Initial name={name} inbox={id === "none"} size={14} />
          </button>
          </div>
        );
      })}
      {menu.menu && (() => {
        const { id, i } = menu.menu.subject;
        return (
          <ContextMenu
            at={menu.menu.at}
            label={`${nameOf(id)}, pinned`}
            head={{ title: nameOf(id), sub: "pinned to the rail" }}
            items={[
              { label: "Work in it", icon: <LogIn size={14} />, disabled: id === current, note: id === current ? "working in it" : undefined, run: () => set(id) },
              // the rail's own short menu; the rest of the project's list is a click away, in the Projects panel
              { label: "Show in Projects", icon: <FolderKanban size={14} />, run: () => openProjects(nameOf(id)) },
              "—",
              { label: "Move up", key: "Alt+↑", icon: <ArrowUp size={14} />, disabled: i === 0, run: () => pins.move(id, i - 1) },
              { label: "Move down", key: "Alt+↓", icon: <ArrowDown size={14} />, disabled: i === pins.ids.length - 1, run: () => pins.move(id, i + 2) },
              "—",
              { label: "Unpin", icon: <PinOff size={14} />, run: () => pins.unpin(id) },
            ]}
            onClose={menu.close}
          />
        );
      })()}
    </div>
  );
}

/**
 * The project the app works in, shown in the rail: the Inbox or one project, then the projects pinned under it. One choice
 * for the whole app. The button opens the Projects panel beside the rail, where it is changed, where projects are pinned,
 * and where projects, their folders, timelines and drafts are made, moved, renamed, archived and deleted.
 */
export function ProjectSwitch() {
  const projects = useProjects();
  const current = useProject((s) => s.id);
  const set = useProject((s) => s.set);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useKeysHere("projects", open);
  const [making, setMaking] = useState(false);
  // an item opened from the panel: large in the Viewer, the panel kept (hidden) underneath and back when it closes
  const [viewing, setViewing] = useState<Asset | null>(null);
  const inbox = current === "none";
  const picked = inbox ? undefined : projects.data?.items.find((p) => p.id === current);
  // a project that is gone, or archived, is no place to work in: the Inbox then (judged on a list that is up to date, not one being read again)
  useEffect(() => {
    if (!inbox && projects.isSuccess && !projects.isFetching && (!picked || picked.archivedAt)) set("none");
  }, [inbox, projects.isSuccess, projects.isFetching, picked, set]);
  // the lists follow by themselves: the library, the drafts and the timelines carry the project in their query keys (data.ts)
  const name = inbox ? "Inbox" : picked?.name ?? "…";
  // a pinned project worked in is shown once, by its pin (outlined, "current"): the button above then only opens the panel,
  // so the same square is not drawn twice, and the pins never move as one is picked
  const onPin = usePins().ids.includes(current);
  const label = onPin ? "Projects" : name;
  // a project in its own colour (projects have none of their own: one picked from the id); the Inbox in the quiet ink
  const tone = picked && !onPin ? projectTone(picked.id) : "var(--color-ink-3)";
  const [search, setSearch] = useState<string | undefined>(undefined);
  const [reveal, setReveal] = useState<Reveal | undefined>(undefined);
  const close = useCallback(() => {
    setOpen(false);
    setSearch(undefined);
    setReveal(undefined);
  }, []);
  // opened from elsewhere (the command bar's "Show in Projects"), its search on what to find
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ search?: string; reveal?: Reveal }>).detail;
      setSearch(d?.search);
      setReveal(d?.reveal);
      setOpen(true);
    };
    window.addEventListener("afflatus:projects", on);
    return () => window.removeEventListener("afflatus:projects", on);
  }, []);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        data-tip={`Working in: ${name}${onPin ? " (its pin is outlined below)" : ""}. The library, the drafts and the timelines are those of ${inbox ? "the Inbox" : "this project"}, and what you make lands in it. Click for your projects.`}
        className={cx("mt-2.5 flex w-[62px] shrink-0 flex-col items-center gap-1 rounded-xl pt-1.5 pb-[7px] text-micro font-semibold", open || (!inbox && !onPin) ? "text-ink" : "text-ink-2 hover:text-ink")}
      >
        {/* the name under it says it: the initial is only a picture */}
        <span
          aria-hidden
          className={cx("flex h-[30px] w-[30px] items-center justify-center rounded-control border-[1.5px] bg-hover text-body font-extrabold", open && "shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]")}
          style={{ borderColor: tone, color: tone }}
        >
          {onPin ? <FolderKanban size={15} /> : <Initial name={picked?.name ?? ""} inbox={inbox} />}
        </span>
        {/* the panel's name over the place: "Projects" is what opens, the place is where you are (review 4, finding 25) */}
        {!onPin && <span className="-mb-1 w-full truncate px-0.5 text-center text-micro font-medium text-ink-3">Projects</span>}
        <span className="w-full truncate px-0.5 text-center">{label}</span>
      </button>
      <Pins current={current} />
      {open && <Suspense fallback={null}><ProjectsPanel key={`${search ?? ""}|${reveal?.asset ?? ""}`} search={search} reveal={reveal} anchor={button} onClose={close} onNew={() => setMaking(true)} onView={setViewing} hidden={Boolean(viewing)} /></Suspense>}
      {viewing && <Suspense fallback={null}><Viewer asset={viewing} onClose={() => setViewing(null)} /></Suspense>}
      {making && <Suspense fallback={null}><NewProject onClose={() => setMaking(false)} onMade={(p) => { setMaking(false); set(p.id); }} /></Suspense>}
    </>
  );
}
