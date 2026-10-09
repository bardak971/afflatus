import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Globe, Inbox } from "lucide-react";
import { api, type Asset, type Project } from "./api";
import { useProjects } from "./data";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "./Dialog";
import { FieldRow } from "./fields";
import { Keys } from "./Keys";
import { useKeysHere } from "./keys/here";
import { useProject } from "./project";
import { Button, cx, ErrorNote, fieldClass } from "./ui";

// the panel loads on its first opening: it is not needed to draw the app
const ProjectsPanel = lazy(() => import("./projects/ProjectsPanel").then((m) => ({ default: m.ProjectsPanel })));
// the Viewer too: fetched the first time an item is opened from the panel
const Viewer = lazy(() => import("./Viewer").then((m) => ({ default: m.Viewer })));

/** The theme's colours a project can wear in the rail: tokens, so that it follows the theme. */
const TONES = ["--color-picture", "--color-good", "--color-warn-ink", "--color-accent", "--color-warn"];
/** A project's colour, the same every time: picked from its id. */
export function projectTone(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(${TONES[h % TONES.length]})`;
}

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
  useKeysHere("projects", open);
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
  // a project in its own colour (projects have none of their own: one picked from the id); All and the Inbox in the quiet ink
  const tone = picked ? projectTone(picked.id) : "var(--color-ink-3)";
  const [search, setSearch] = useState<string | undefined>(undefined);
  const close = useCallback(() => {
    setOpen(false);
    setSearch(undefined);
  }, []);
  // opened from elsewhere (the command bar's "Show in Projects"), its search on what to find
  useEffect(() => {
    const on = (e: Event) => {
      setSearch((e as CustomEvent<{ search?: string }>).detail?.search);
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
        data-tip={`Working in: ${label}. The library, the drafts and the timelines are those of ${current === null ? "every project" : current === "none" ? "the Inbox" : "this project"}. Click for your projects.`}
        className={cx("mt-2.5 flex w-[62px] shrink-0 flex-col items-center gap-1 rounded-[12px] pt-1.5 pb-[7px] text-[10.5px] font-semibold", open || current ? "text-ink" : "text-ink-2 hover:text-ink")}
      >
        {/* the name under it says it: the initial is only a picture */}
        <span
          aria-hidden
          className={cx("flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border-[1.5px] bg-hover text-[13px] font-extrabold", open && "shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]")}
          style={{ borderColor: tone, color: tone }}
        >
          {current === null ? <Globe size={15} /> : current === "none" ? <Inbox size={15} /> : (Array.from(picked?.name.trim() ?? "")[0] ?? "…").toUpperCase()}
        </span>
        <span className="w-full truncate px-0.5 text-center">{label}</span>
      </button>
      {open && <Suspense fallback={null}><ProjectsPanel key={search ?? ""} search={search} anchor={button} onClose={close} onNew={() => setMaking(true)} onView={setViewing} hidden={Boolean(viewing)} /></Suspense>}
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
