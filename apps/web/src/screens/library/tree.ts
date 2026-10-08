import type { Folder } from "../../api";

/** Folders in reading order, each with how deep it sits. A folder whose parent is missing comes last, at the top level. */
export function tree(folders: Folder[]): Array<Folder & { depth: number }> {
  const out: Array<Folder & { depth: number }> = [];
  const placed = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parentId === parent)) {
      // a folder met twice (a loop of parents) is shown once
      if (placed.has(f.id)) continue;
      placed.add(f.id);
      out.push({ ...f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  // a folder whose parent is missing still has to be reachable
  for (const f of folders) if (!placed.has(f.id)) out.push({ ...f, depth: 0 });
  return out;
}

/** The folders of the project the app looks at: every one (null), those in no project ("none"), or that project's. */
export const foldersOf = (folders: Folder[], project: string | null) =>
  folders.filter((f) => (project === null ? true : project === "none" ? f.projectId === null : f.projectId === project));
