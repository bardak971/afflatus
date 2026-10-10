import { Fragment, Suspense, useLayoutEffect, useState, type RefObject } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import type { Asset, Folder } from "../../api";
import { useFolders, useProjects } from "../../data";
import { leaveCopy } from "../../leave";
import { useProject } from "../../project";
import { Initial, projectTone } from "../../projects/tone";
import type { Place } from "../../store";
import { cx } from "../../ui";
import { lazyPart, loadProjectsPanel, loadViewer } from "../../lazyParts";

// the tree is the Projects panel's own, loaded the first time it opens: it is not needed to draw the library
const ProjectsPanel = lazyPart(loadProjectsPanel, (m) => m.ProjectsPanel);
// the Viewer too: fetched the first time an item is opened from the tree
const Viewer = lazyPart(loadViewer, (m) => m.Viewer);

/** One step of the breadcrumb: what it says, and the place a click on it goes to. */
interface Crumb {
  key: string;
  label: string;
  place: Place;
  /** The project's own crumb: its square in front. */
  head?: boolean;
  bin?: boolean;
}

/** Past this many crumbs, the middle ones fold into "…" (the tree under it has them all). */
const MOST = 3;

/**
 * The library's place as a path inside the project worked in: "Showcase › Big Air › Keyframes". The project's root
 * folder is left out of the path (the project's crumb stands for it), and only said when it is the place itself.
 */
export function crumbsOf(place: Place, projectName: string, rootId: string | null, folders: readonly Folder[]): Crumb[] {
  const head: Crumb = { key: "project", label: projectName, place: { type: "all" }, head: true };
  if (place.type === "bin") return [head, { key: "bin", label: "Bin", place, bin: true }];
  if (place.type === "unfiled") return [head, { key: "loose", label: "No folder", place }];
  if (place.type !== "folder") return [head];
  if (place.id === rootId) return [head, { key: `f:${place.id}`, label: "root folder", place }];
  const chain: Crumb[] = [];
  const seen = new Set<string>();
  for (let f = folders.find((x) => x.id === place.id); f && !seen.has(f.id) && f.id !== rootId; f = f.parentId ? folders.find((x) => x.id === f!.parentId) : undefined) {
    seen.add(f.id);
    chain.unshift({ key: `f:${f.id}`, label: f.name, place: { type: "folder", id: f.id } });
  }
  // a folder not read yet: its crumb waits, rather than a wrong path
  return chain.length ? [head, ...chain] : [head, { key: `f:${place.id}`, label: "…", place }];
}

/** The crumbs drawn: the first, "…" for the middle ones when there are too many, the last two. */
export function foldCrumbs<T>(crumbs: readonly T[], most = MOST): Array<T | "…"> {
  return crumbs.length > most ? [crumbs[0]!, "…", ...crumbs.slice(-(most - 1))] : [...crumbs];
}

/**
 * Where the library is, as a breadcrumb inside the project worked in. Each crumb goes to its place (the project's: the
 * whole project); the last one, "…" and the chevron open this project's tree under it. It never lists another project:
 * the rail switches projects. Its width is fixed, so the header does not move when the path changes length.
 */
export function PlaceCrumbs({ place, onPlace, anchor, open, onOpen, className }: {
  place: Place;
  onPlace(p: Place): void;
  /** The breadcrumb itself: the tree opens under it. */
  anchor: RefObject<HTMLDivElement | null>;
  open: boolean;
  onOpen(open: boolean): void;
  className?: string;
}) {
  const project = useProject((s) => s.id);
  const folders = useFolders();
  const projects = useProjects();
  const group = project === "none" ? null : project;
  const p = group ? projects.data?.items.find((x) => x.id === group) : undefined;
  const name = group === null ? "Inbox" : p?.name;
  const crumbs = name === undefined ? null : crumbsOf(place, name, p?.folderId ?? null, folders.data?.items ?? []);
  const toggle = () => onOpen(!open);
  const go = (to: Place) => {
    onPlace(to);
    onOpen(false);
  };
  const tone = p ? projectTone(p.id) : "var(--color-ink-3)";
  return (
    <div
      ref={anchor}
      role="navigation"
      aria-label="Where the library is"
      className={cx("flex h-9 w-[clamp(190px,22vw,320px)] min-w-0 shrink-0 items-center rounded-lg border bg-raised pr-0.5 pl-1 text-sm font-semibold transition-colors duration-150", open ? "border-accent" : "border-line-strong", className)}
    >
      {!crumbs ? (
        // the project not read yet: a quiet bar where its name goes, the same height
        <span aria-label="Reading the project" className="mx-2 h-3 w-24 animate-pulse rounded bg-hover motion-reduce:animate-none" />
      ) : (
        foldCrumbs(crumbs).map((c, i, all) => {
          const last = i === all.length - 1;
          return (
            <Fragment key={c === "…" ? "more" : c.key}>
              {i > 0 && <ChevronRight size={13} aria-hidden className="shrink-0 text-ink-3" />}
              {c === "…" ? (
                <button type="button" aria-label="The folders between: open the tree" data-tip="Open this project's tree" onClick={toggle} className="shrink-0 rounded-md px-1.5 py-1 text-ink-2 hover:bg-hover hover:text-ink">
                  …
                </button>
              ) : (
                <button
                  type="button"
                  aria-current={last ? "location" : undefined}
                  aria-expanded={last ? open : undefined}
                  data-tip={last ? (c.bin ? "The bin of every project: items wait there a week. Click for this project's tree" : "Click for this project's tree") : c.head ? `The whole of ${c.label}` : `Go to ${c.label}`}
                  onClick={() => (last ? toggle() : go(c.place))}
                  className={cx(
                    "flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-hover",
                    last ? "text-ink-strong" : "text-ink-2 hover:text-ink",
                    // the project's own crumb gives way first, the place itself last
                    c.head && !last ? "max-w-[45%] shrink-[2]" : "shrink",
                  )}
                >
                  {c.head && (
                    <span aria-hidden className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border text-[10px] font-extrabold" style={{ borderColor: tone, color: tone }}>
                      <Initial name={c.label} inbox={group === null} size={11} />
                    </span>
                  )}
                  {c.bin && <Trash2 size={13} aria-hidden className="shrink-0" />}
                  <span className="truncate">{c.label}</span>
                </button>
              )}
            </Fragment>
          );
        })
      )}
      <span className="min-w-1 grow" />
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${name ?? "This project"}: folders, timelines and drafts`}
        data-tip="This project's folders, timelines and drafts"
        onClick={toggle}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"
      >
        <ChevronDown size={14} className={cx("transition-transform duration-150 motion-reduce:transition-none", open && "rotate-180")} />
      </button>
    </div>
  );
}

/**
 * The project worked in as a tree, under the library's breadcrumb: the Projects panel's own tree for this one project
 * (folders, timelines, drafts, sizes, keys, drag and drop), its rows places of the library. Items opened from it show in
 * the Viewer, the tree kept underneath.
 */
export function FolderPanel({ place, onPlace, dragging, anchor, onClose }: {
  place: Place;
  onPlace(p: Place): void;
  /** Something is being dragged: the tree is there to drop it on a folder. */
  dragging?: boolean;
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  const project = useProject((s) => s.id);
  const [viewing, setViewing] = useState<Asset | null>(null);
  // the tree is the Projects panel's (portalled, its own markup and its own way in): closed, it fades as a still copy,
  // found by the name it gives itself, while it is still on the page
  useLayoutEffect(() => () => {
    const tree = document.querySelector<HTMLElement>('[role="dialog"][aria-label$=": folders, timelines and drafts"]');
    if (tree) leaveCopy(tree, "m-pop-out");
  }, []);
  return (
    <>
      <Suspense fallback={null}>
        <ProjectsPanel key={project} anchor={anchor} onClose={onClose} onView={setViewing} hidden={Boolean(viewing)} scope={{ group: project === "none" ? null : project, place, onPlace, dragging }} />
      </Suspense>
      {viewing && <Suspense fallback={null}><Viewer asset={viewing} onClose={() => setViewing(null)} /></Suspense>}
    </>
  );
}
