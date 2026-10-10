import { Suspense, useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Reveal } from "./bar/bridge";
import { FolderKanban, FolderPlus } from "lucide-react";
import { api, type Asset, type Project } from "./api";
import { useProjects } from "./data";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "./Dialog";
import { FieldRow } from "./fields/FieldRow";
import { Keys } from "./Keys";
import { useKeysHere } from "./keys/here";
import { useProject } from "./project";
import { usePins } from "./projects/pins";
import { Initial, projectTone } from "./projects/tone";
import { Button, cx, ErrorNote, fieldClass } from "./ui";
import { useFlip } from "./useFlip";
import { lazyPart, loadProjectsPanel, loadViewer } from "./lazyParts";
import { queryKeys } from "./queryKeys";

// the panel loads on its first opening: it is not needed to draw the app
const ProjectsPanel = lazyPart(loadProjectsPanel, (m) => m.ProjectsPanel);
// the Viewer too: fetched the first time an item is opened from the panel (a lazy import is only that when no file
// loaded with the app imports the Viewer itself: the screens take it through viewer/LazyViewer.tsx)
const Viewer = lazyPart(loadViewer, (m) => m.Viewer);

/** The type of a pin dragged along the rail: only the rail's own pins take it. */
const DRAG_PIN = "application/x-afflatus-pin";

/**
 * The projects pinned to the rail, under the one worked in: one click works in each, the active one outlined. Dragged
 * along the rail they change places; they are pinned and unpinned from the Projects panel's row menu.
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
            data-tip={on ? "Working in it. Drag, or Alt + ↑ ↓, to reorder the pins." : "Click to work in it. Drag, or Alt + ↑ ↓, to reorder the pins."}
            onClick={() => set(id)}
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
              "relative flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border bg-hover text-[13px] font-extrabold transition-[border-color,box-shadow] duration-150 motion-reduce:transition-none",
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
        className={cx("mt-2.5 flex w-[62px] shrink-0 flex-col items-center gap-1 rounded-[12px] pt-1.5 pb-[7px] text-[10.5px] font-semibold", open || (!inbox && !onPin) ? "text-ink" : "text-ink-2 hover:text-ink")}
      >
        {/* the name under it says it: the initial is only a picture */}
        <span
          aria-hidden
          className={cx("flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border-[1.5px] bg-hover text-[13px] font-extrabold", open && "shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]")}
          style={{ borderColor: tone, color: tone }}
        >
          {onPin ? <FolderKanban size={15} /> : <Initial name={picked?.name ?? ""} inbox={inbox} />}
        </span>
        <span className="w-full truncate px-0.5 text-center">{label}</span>
      </button>
      <Pins current={current} />
      {open && <Suspense fallback={null}><ProjectsPanel key={`${search ?? ""}|${reveal?.asset ?? ""}`} search={search} reveal={reveal} anchor={button} onClose={close} onNew={() => setMaking(true)} onView={setViewing} hidden={Boolean(viewing)} /></Suspense>}
      {viewing && <Suspense fallback={null}><Viewer asset={viewing} onClose={() => setViewing(null)} /></Suspense>}
      {making && <NewProject onClose={() => setMaking(false)} onMade={(p) => { setMaking(false); set(p.id); }} />}
    </>
  );
}

function NewProject({ onClose, onMade }: { onClose(): void; onMade(p: Project): void }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const make = useMutation({
    mutationFn: (n: string) => api.createProject(n),
    onSuccess: (p) => {
      // its root folder: the server says it with a "library" event, which reads the folders again
      void client.invalidateQueries({ queryKey: queryKeys.projects.all() });
      onMade(p);
    },
  });
  return (
    // over the Projects panel it is opened from
    <Dialog label="New project" onClose={onClose} z="z-[70]" className={DIALOG}>
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) make.mutate(name.trim());
        }}
      >
        <DialogHead icon={<FolderPlus size={16} />} title="New project" sub="Drafts, timelines and folders, with a root folder of its name" onClose={onClose} />
        <FieldRow label="Name" htmlFor="new-project-name" note="A project holds drafts, timelines and folders. It gets a root folder of the same name, where its renders land unless another folder of it is open. The library, the drafts and the timelines then show this project's.">
          <input id="new-project-name" autoFocus aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" maxLength={120} className={cx(fieldClass, "h-10")} />
        </FieldRow>
        {make.isError && <ErrorNote>{make.error.message}</ErrorNote>}
        <DialogFoot>
          <Button tone="quiet" type="button" onClick={onClose}>Cancel <Keys keys="Esc" size="sm" /></Button>
          <Button tone="primary" type="submit" disabled={!name.trim() || make.isPending}>Create <Keys keys="Enter" size="sm" /></Button>
        </DialogFoot>
      </form>
    </Dialog>
  );
}
