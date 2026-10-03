import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Check, FolderKanban, Pencil, Plus, Trash2 } from "lucide-react";
import { api, type Project } from "./api";
import { ContextMenu, useMenu, type MenuItem } from "./ContextMenu";
import { useProjects } from "./data";
import { useProject, type ProjectChoice } from "./project";
import { Button, cx, ErrorNote } from "./ui";

/**
 * The project the app looks at, picked in the rail: everything, the Inbox, or one project. One choice for
 * the whole app. From the same menu a project is made, and a dialog renames, archives or deletes them.
 */
export function ProjectSwitch() {
  const client = useQueryClient();
  const projects = useProjects();
  const current = useProject((s) => s.id);
  const set = useProject((s) => s.set);
  const { menu, open, close } = useMenu<true>();
  const [making, setMaking] = useState(false);
  const [managing, setManaging] = useState(false);
  const live = (projects.data?.items ?? []).filter((p) => !p.archivedAt);
  const picked = current && current !== "none" ? projects.data?.items.find((p) => p.id === current) : undefined;
  // a project that is gone, or archived, is no place to look at (judged on a list that is up to date, not one being read again)
  useEffect(() => {
    if (current && current !== "none" && projects.isSuccess && !projects.isFetching && (!picked || picked.archivedAt)) set(null);
  }, [current, projects.isSuccess, projects.isFetching, picked, set]);
  const choose = (id: ProjectChoice) => {
    set(id);
    // the lists follow: the library, the drafts, the timelines
    void client.invalidateQueries({ queryKey: ["assets"] });
    void client.invalidateQueries({ queryKey: ["drafts"], exact: true });
    void client.invalidateQueries({ queryKey: ["timelines"] });
  };
  const label = current === null ? "All" : current === "none" ? "Inbox" : picked?.name ?? "…";
  const tick = (on: boolean) => (on ? <Check size={14} /> : <span className="inline-block w-3.5" />);
  const items: MenuItem[] = [
    { label: "All", icon: tick(current === null), note: "everything, every project", run: () => choose(null) },
    { label: "Inbox", icon: tick(current === "none"), note: projects.data ? `${projects.data.inbox.drafts} drafts · ${projects.data.inbox.timelines} timelines · ${projects.data.inbox.assets} items in no project` : "what is in no project", run: () => choose("none") },
    ...(live.length ? ["—" as const] : []),
    ...live.map((p): MenuItem => ({ label: p.name, icon: tick(current === p.id), note: `${p.drafts} drafts · ${p.timelines} timelines · ${p.assets} items`, run: () => choose(p.id) })),
    "—" as const,
    { label: "New project…", icon: <Plus size={14} />, run: () => setMaking(true) },
    { label: "Manage projects…", icon: <FolderKanban size={14} />, note: "rename, archive, delete", run: () => setManaging(true) },
  ];
  return (
    <>
      <button
        type="button"
        onClick={(e) => open(e, true)}
        title={`Looking at: ${label}. The library, the drafts and the timelines are those of ${current === null ? "every project" : current === "none" ? "the Inbox" : "this project"}. Click to change.`}
        className={cx("mb-1 flex h-9 w-[64px] flex-col items-center justify-center gap-0.5 rounded-[10px] px-1 text-[10px] font-semibold", current ? "bg-accent-wash text-accent" : "text-ink-2 hover:text-ink")}
      >
        <FolderKanban size={14} />
        <span className="w-full truncate text-center">{label}</span>
      </button>
      {menu && <ContextMenu at={menu.at} label="Project" items={items} onClose={close} />}
      {making && <NewProject onClose={() => setMaking(false)} onMade={(p) => { setMaking(false); choose(p.id); }} />}
      {managing && <ManageProjects onClose={() => setManaging(false)} />}
    </>
  );
}

function NewProject({ onClose, onMade }: { onClose(): void; onMade(p: Project): void }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const make = useMutation({
    mutationFn: (n: string) => api.createProject(n),
    onSuccess: (p) => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      void client.invalidateQueries({ queryKey: ["assets", "folders"] });
      onMade(p);
    },
  });
  return (
    <div role="dialog" aria-modal="true" aria-label="New project" className="fixed inset-0 z-40 flex items-center justify-center bg-ground/85 p-8" onClick={onClose}>
      <form
        className="flex w-full max-w-md flex-col gap-3.5 rounded-2xl border border-line-strong bg-panel p-5"
        onClick={(e) => e.stopPropagation()}
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
    </div>
  );
}

function ManageProjects({ onClose }: { onClose(): void }) {
  const client = useQueryClient();
  const projects = useProjects();
  const current = useProject((s) => s.id);
  const set = useProject((s) => s.set);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["projects"] });
    void client.invalidateQueries({ queryKey: ["assets"] });
    void client.invalidateQueries({ queryKey: ["drafts"], exact: true });
    void client.invalidateQueries({ queryKey: ["timelines"] });
  };
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.editProject(v.id, { name: v.name }), onSuccess: () => { setEditing(null); refresh(); } });
  const archive = useMutation({ mutationFn: (v: { id: string; archived: boolean }) => api.editProject(v.id, { archived: v.archived }), onSuccess: (_p, v) => { if (v.archived && current === v.id) set(null); refresh(); } });
  const remove = useMutation({ mutationFn: api.deleteProject, onSuccess: (_r, id) => { if (current === id) set(null); setDeleting(null); refresh(); } });
  const error = rename.error ?? archive.error ?? remove.error ?? projects.error;
  const items = projects.data?.items ?? [];
  return (
    <div role="dialog" aria-modal="true" aria-label="Projects" className="fixed inset-0 z-40 flex items-center justify-center bg-ground/85 p-8" onClick={onClose}>
      <div className="flex w-full max-w-xl flex-col gap-3 rounded-2xl border border-line-strong bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <span className="text-base font-semibold">Projects</span>
        <span className="text-xs text-ink-2">Archiving hides a project with everything in it; deleting sends its drafts, timelines and folders to the Inbox. Nothing is removed from the library either way.</span>
        {error && <ErrorNote>{error.message}</ErrorNote>}
        {projects.isSuccess && !items.length && <span className="text-ink-2">No project yet. Make one from the menu in the rail.</span>}
        <div className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
          {items.map((p) => (
            <div key={p.id} className={cx("flex items-center gap-2 rounded-lg border border-line px-3 py-2", p.archivedAt && "opacity-60")}>
              {editing?.id === p.id ? (
                <form className="flex min-w-0 grow items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (editing.name.trim()) rename.mutate({ id: p.id, name: editing.name.trim() }); }}>
                  <input autoFocus aria-label="Project name" value={editing.name} onChange={(e) => setEditing({ id: p.id, name: e.target.value })} maxLength={120} className="h-8 min-w-0 grow rounded-lg border border-accent bg-raised px-2 text-ink" />
                  <Button size="sm" tone="primary" type="submit" disabled={rename.isPending}>Save</Button>
                  <Button size="sm" tone="quiet" type="button" onClick={() => setEditing(null)}>Cancel</Button>
                </form>
              ) : (
                <>
                  <div className="flex min-w-0 grow flex-col">
                    <span className="truncate font-semibold">{p.name}{p.archivedAt ? <span className="font-normal text-ink-3"> · archived</span> : ""}</span>
                    <span className="text-xs text-ink-2">{p.drafts} draft{p.drafts === 1 ? "" : "s"} · {p.timelines} timeline{p.timelines === 1 ? "" : "s"} · {p.assets} item{p.assets === 1 ? "" : "s"}</span>
                  </div>
                  {deleting === p.id ? (
                    <>
                      <span className="text-xs text-ink-2">Its things go to the Inbox.</span>
                      <button type="button" onClick={() => remove.mutate(p.id)} className="rounded-md bg-warn px-2 py-1 text-xs font-bold text-warn-on">Delete</button>
                      <button type="button" onClick={() => setDeleting(null)} className="rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-hover">Cancel</button>
                    </>
                  ) : (
                    <>
                      <button type="button" aria-label={`Rename ${p.name}`} title="Rename" onClick={() => setEditing({ id: p.id, name: p.name })} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><Pencil size={14} /></button>
                      <button type="button" aria-label={p.archivedAt ? `Unarchive ${p.name}` : `Archive ${p.name}`} title={p.archivedAt ? "Unarchive: show it again" : "Archive: hide it with everything in it"} onClick={() => archive.mutate({ id: p.id, archived: !p.archivedAt })} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink">{p.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}</button>
                      <button type="button" aria-label={`Delete ${p.name}`} title="Delete the project: its drafts, timelines and folders go to the Inbox" onClick={() => setDeleting(p.id)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-warn-ink"><Trash2 size={14} /></button>
                    </>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
        <div><Button tone="quiet" onClick={onClose}>Close</Button></div>
      </div>
    </div>
  );
}
