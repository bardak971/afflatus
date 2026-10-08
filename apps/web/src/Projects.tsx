import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import { api, type Asset, type Project } from "./api";
import { useProjects } from "./data";
import { Dialog } from "./Dialog";
import { useProject } from "./project";
import { Button, cx, ErrorNote } from "./ui";

// the panel loads on its first opening: it is not needed to draw the app
const ProjectsPanel = lazy(() => import("./projects/ProjectsPanel").then((m) => ({ default: m.ProjectsPanel })));
// the Viewer too: fetched the first time an item is opened from the panel
const Viewer = lazy(() => import("./Viewer").then((m) => ({ default: m.Viewer })));

/**
 * The project the app looks at, shown in the rail: everything, the Inbox, or one project. One choice for
 * the whole app. The button opens the Projects panel beside the rail, where it is changed, and where
 * projects, their folders, timelines and drafts are made, moved, renamed, archived and deleted.
 */
export function ProjectSwitch() {
  const projects = useProjects();
  const current = useProject((s) => s.id);
  const set = useProject((s) => s.set);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [making, setMaking] = useState(false);
  // an item opened from the panel: large in the Viewer, the panel kept (hidden) underneath and back when it closes
  const [viewing, setViewing] = useState<Asset | null>(null);
  const picked = current && current !== "none" ? projects.data?.items.find((p) => p.id === current) : undefined;
  // a project that is gone, or archived, is no place to look at (judged on a list that is up to date, not one being read again)
  useEffect(() => {
    if (current && current !== "none" && projects.isSuccess && !projects.isFetching && (!picked || picked.archivedAt)) set(null);
  }, [current, projects.isSuccess, projects.isFetching, picked, set]);
  // the lists follow by themselves: the library, the drafts and the timelines carry the project in their query keys (data.ts)
  const label = current === null ? "All" : current === "none" ? "Inbox" : picked?.name ?? "…";
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        title={`Working in: ${label}. The library, the drafts and the timelines are those of ${current === null ? "every project" : current === "none" ? "the Inbox" : "this project"}. Click for your projects.`}
        className={cx("mb-1 flex h-9 w-[64px] flex-col items-center justify-center gap-0.5 rounded-[10px] px-1 text-[10px] font-semibold", open ? "bg-accent-wash text-accent shadow-[inset_0_0_0_1px_var(--color-accent)]" : current ? "bg-accent-wash text-accent" : "text-ink-2 hover:text-ink")}
      >
        <FolderKanban size={14} />
        <span className="w-full truncate text-center">{label}</span>
      </button>
      {open && <Suspense fallback={null}><ProjectsPanel anchor={button} onClose={close} onNew={() => setMaking(true)} onView={setViewing} hidden={Boolean(viewing)} /></Suspense>}
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
      void client.invalidateQueries({ queryKey: ["projects"] });
      onMade(p);
    },
  });
  return (
    // over the Projects panel it is opened from
    <Dialog label="New project" onClose={onClose} z="z-[70]">
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) make.mutate(name.trim());
        }}
      >
        <span className="text-base font-semibold">New project</span>
        <span className="text-ink-2">A project holds drafts, timelines and folders. It gets a root folder of the same name, where its renders land unless another folder of it is open. The library, the drafts and the timelines then show this project's.</span>
        <input autoFocus aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" maxLength={120} className="h-10 rounded-lg border border-line bg-raised px-3 text-ink placeholder:text-ink-3" />
        {make.isError && <ErrorNote>{make.error.message}</ErrorNote>}
        <div className="flex gap-2">
          <Button tone="primary" type="submit" disabled={!name.trim() || make.isPending}>Create</Button>
          <Button tone="quiet" type="button" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Dialog>
  );
}
