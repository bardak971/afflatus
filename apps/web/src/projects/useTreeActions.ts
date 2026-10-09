import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { bringFiles } from "../bringFiles";
import { ask, askAboutDisk, askText } from "../Confirm";
import { DRAFT_LIST } from "../data";
import { size } from "../format";
import { pathOf, useFolderImport } from "../folderImport";
import { useProject } from "../project";
import { useBanners, useOpenDraft } from "../store";
import { planBin, planDrop, type Moving, type Row, type Target } from "./tree";

/** Before a folder of the disk is unlinked: the question both folder trees ask (the folder panel's and the Projects panel's). */
export const askUnlink = (name: string) =>
  ask({ title: `Unlink ${name}?`, text: "Afflatus stops showing it and its sub-folders. Nothing on your disk is touched: its files stay where they are. It can be linked again later.", yes: "Unlink" });
/** Before one folder is deleted, from either folder tree. */
export const askDeleteFolder = (name: string) =>
  ask({ title: `Delete ${name}?`, text: "Its items move to the folder above it. A deleted folder cannot be restored from the bin.", yes: "Delete" });

/**
 * What the Projects panel changes: moves, deletes, renames, new folders, root folders, archiving. Each
 * says what went wrong in a banner; after each, the projects, the timelines, the drafts and the folders
 * are read again (the server's own events cover most of it, not the drafts).
 */
export function useTreeActions() {
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const refresh = () => {
    for (const queryKey of [["projects"], ["timelines"], DRAFT_LIST, ["folders"], ["assets"]]) void client.invalidateQueries({ queryKey });
  };
  // a 409 is the server saying what still uses it (a timeline's clip, a person of the Prompt kit): said as such
  const failed = (title: string) => (err: unknown) =>
    say({ id: `tree:${Date.now()}`, tone: "bad", title: err instanceof ApiError && err.status === 409 ? "Still in use" : title, text: err instanceof Error ? err.message : String(err), href: "/", go: "Open the Studio" });
  /** Runs one change; false when it failed (said in a banner). */
  const run = async (title: string, work: () => Promise<unknown>) => {
    try {
      await work();
      return true;
    } catch (err) {
      failed(title)(err);
      return false;
    } finally {
      refresh();
    }
  };

  const named = (items: Array<{ name: string }>) => (items.length === 1 ? items[0]!.name : `${items.length} items`);

  const self = {
    refresh,
    /** Rows dropped on a project, the Inbox or a folder (or sent there from "Move to"). Refused drops do nothing. */
    async move(items: Moving[], t: Target, onOpen?: () => void) {
      const ops = planDrop(items, t);
      if (!ops) return;
      const moved = items.filter((m) => ops.some((o) => o.id === m.id));
      // one after the other: two folders of one branch moved together land the same whatever the order
      const ok = await run(`${named(moved)} could not be moved`, async () => {
        // items: one call per folder they go to
        const into = new Map<string, string[]>();
        for (const op of ops) if (op.kind === "asset") into.set(op.folder, [...(into.get(op.folder) ?? []), op.id]);
        for (const [folder, ids] of into) await api.moveAssets(ids, folder);
        for (const op of ops) {
          if (op.kind === "asset") continue;
          if (op.kind === "folder") await api.editFolder(op.id, op.patch);
          else if (op.kind === "timeline") await api.editTimeline(op.id, op.patch);
          else await api.moveDraft(op.id, op.project);
        }
      });
      if (ok) {
        say({
          id: `tree-moved:${Date.now()}`, tone: "good", title: `${named(moved)} moved to ${t.name}`,
          text: moved.some((m) => m.kind === "timeline") ? "A timeline takes its takes, finishes and export along." : moved.some((m) => m.kind === "folder") ? "With the folders and items inside." : undefined,
          href: "/", go: "Open it", ...(onOpen ? { act: onOpen } : {}),
        });
      }
    },
    /** Folders, timelines and drafts deleted, items sent to the bin, once asked. Projects are never deleted together. */
    async remove(rows: Row[]) {
      // a sub-folder of a folder of the disk is not deleted from here (the server refuses it): only its root is unlinked
      const list = rows.filter((r) => r.id && ((r.kind === "folder" && (!r.linked || r.linkedRoot)) || r.kind === "timeline" || r.kind === "draft" || r.kind === "item"));
      const onDisk = list.filter((r) => r.asset?.path).length;
      if (!list.length) return;
      const one = list.length === 1;
      const lines = [
        list.some((r) => r.kind === "folder" && !r.linked) && "A folder's items move to the folder above it.",
        list.some((r) => r.kind === "folder" && r.linked) && "A folder of your disk is unlinked: nothing on your disk is touched.",
        list.some((r) => r.kind === "timeline") && "A timeline's videos stay in your library; only the sequence goes.",
        list.some((r) => r.kind === "draft") && "A draft goes with its form and conversation; what was made from it stays.",
        list.some((r) => r.kind !== "item") && "Folders, timelines and drafts deleted cannot be restored from the bin.",
        list.some((r) => r.kind === "item") && "Items go to the bin: for a week they can be restored from it.",
        onDisk > 0 && `${onDisk === 1 ? "One item is a file" : `${onDisk} items are files`} of a linked folder: the bin removes ${onDisk === 1 ? "it" : "them"} from that folder on your disk.`,
      ].filter(Boolean);
      const binOnly = list.every((r) => r.kind === "item");
      const title = binOnly ? (one ? `Move ${list[0]!.label} to the bin?` : `Move these ${list.length} items to the bin?`) : one ? `Delete ${list[0]!.label}?` : `Delete these ${list.length}?`;
      // one folder alone: the question the folder panel asks for it
      const lone = one && list[0]!.kind === "folder" ? list[0]! : null;
      const yes = lone ? await (lone.linked ? askUnlink(lone.label) : askDeleteFolder(lone.label)) : await ask({ title, text: lines.join("\n"), yes: binOnly ? "Move to bin" : "Delete" });
      if (!yes) return;
      const binned = list.filter((r) => r.kind === "item").length;
      const ok = await run(one ? `${list[0]!.label} could not be deleted` : "Some could not be deleted", async () => {
        const items = list.filter((r) => r.kind === "item").map((r) => r.id!);
        if (items.length) await api.bulkAssets(items, "bin");
        for (const r of list) {
          if (r.kind === "item") continue;
          if (r.kind === "folder") await api.deleteFolder(r.id!);
          else if (r.kind === "timeline") await api.deleteTimeline(r.id!);
          else {
            await api.deleteDraft(r.id!);
            client.removeQueries({ queryKey: ["drafts", r.id] });
            if (useOpenDraft.getState().id === r.id) useOpenDraft.getState().open(null);
          }
        }
      });
      if (ok && binned) say({ id: `tree-bin:${Date.now()}`, tone: "good", title: `${binned === 1 ? "1 item" : `${binned} items`} moved to the bin`, text: "For a week they can be restored from it.", href: "/", go: "Open the Studio" });
    },
    /**
     * Rows dropped on the Bin: items go to the bin (asked only for files of the disk); folders, timelines and
     * drafts are deleted once asked, as Delete does, and cannot be restored.
     */
    async bin(rows: Row[]) {
      const moving = rows.map((r) => r.moving).filter((m): m is Moving => Boolean(m));
      const plan = planBin(moving);
      if (!plan) return;
      const others = rows.filter((r) => r.kind !== "item");
      if (others.length) return self.remove(rows);
      const items = rows.filter((r) => r.kind === "item" && r.asset);
      if (!(await askAboutDisk(items.map((r) => ({ name: r.label, path: r.asset!.path }))))) return;
      if (await run(items.length === 1 ? `${items[0]!.label} could not go to the bin` : "They could not go to the bin", () => api.bulkAssets(plan.assets, "bin"))) {
        say({ id: `tree-bin:${Date.now()}`, tone: "good", title: `${items.length === 1 ? items[0]!.label : `${items.length} items`} moved to the bin`, text: "For a week they can be restored from it.", href: "/", go: "Open the Studio" });
      }
    },
    async removeProject(r: Row) {
      if (!r.id || r.kind !== "project") return;
      if (!(await ask({ title: `Delete ${r.label}?`, text: "Its drafts, timelines and folders go to the Inbox. Nothing is removed from the library.", yes: "Delete" }))) return;
      const id = r.id;
      if (await run(`${r.label} could not be deleted`, () => api.deleteProject(id)) && useProject.getState().id === id) useProject.getState().set("none");
      // the server took it out of the rail's pins
      void client.invalidateQueries({ queryKey: ["settings"] });
    },
    rename(r: Row, name: string) {
      const id = r.id;
      if (!id || !name || name === r.label) return Promise.resolve(false);
      return run(`${r.label} could not be renamed`, () =>
        r.kind === "project" ? api.editProject(id, { name }) : r.kind === "folder" ? api.editFolder(id, { name }) : api.editTimeline(id, { name }),
      );
    },
    archive(r: Row, archived: boolean) {
      const id = r.id;
      if (!id) return;
      void run(`${r.label} could not be ${archived ? "archived" : "unarchived"}`, async () => {
        await api.editProject(id, { archived });
        if (archived && useProject.getState().id === id) useProject.getState().set("none");
        // archived, it left the rail's pins on the server
        if (archived) void client.invalidateQueries({ queryKey: ["settings"] });
      });
    },
    /**
     * Items or timelines of the library (the grid's drag) dropped on a row of the tree: items into a folder, a project's
     * root folder, or out of every folder (the Inbox's No folder row: `t` null); timelines filed in a folder or at the top
     * of a project. Refused where the tree refuses it: timelines into a folder of the disk, items onto a project without a
     * root folder. Answers whether it was taken.
     */
    async fromLibrary(what: { assets: string[]; timelines: string[] }, t: Target | null) {
      const into = t === null ? null : t.kind === "folder" ? t.id : t.root;
      const assets = what.assets.length && (t === null || into !== null) ? what.assets : [];
      const timelines = what.timelines.length && t !== null && !(t.kind === "folder" && t.linked) ? what.timelines : [];
      if (!assets.length && !timelines.length) return false;
      const name = t === null ? "No folder" : t.name;
      const n = assets.length + timelines.length;
      const ok = await run(`${n === 1 ? "It" : `These ${n}`} could not be moved to ${name}`, async () => {
        if (assets.length) await api.moveAssets(assets, into);
        for (const id of timelines) await api.editTimeline(id, t!.kind === "folder" ? { project: t!.group, folder: t!.id } : { project: t!.group, folder: null });
      });
      if (ok) say({ id: `tree-moved:${Date.now()}`, tone: "good", title: `${n === 1 ? (timelines.length ? "1 timeline" : "1 item") : `${n} ${timelines.length && !assets.length ? "timelines" : "items"}`} moved to ${name}`, href: "/", go: "Open the Studio" });
      return ok;
    },
    /** Items of the library dropped on the Bin: to the bin, once asked when some are files of a linked folder. */
    async binLibrary(ids: string[]) {
      if (!ids.length) return;
      const items = await Promise.all(ids.map((id) => api.asset(id)));
      if (!(await askAboutDisk(items.map((a) => ({ name: a.shownName || a.name || "Item", path: a.path }))))) return;
      if (await run(ids.length === 1 ? "It could not go to the bin" : "They could not go to the bin", () => api.bulkAssets(ids, "bin"))) {
        say({ id: `tree-bin:${Date.now()}`, tone: "good", title: `${ids.length === 1 ? "1 item" : `${ids.length} items`} moved to the bin`, text: "For a week they can be restored from it.", href: "/", go: "Open the Studio" });
      }
    },
    /** The bin emptied now instead of after its week, once asked: it cannot be undone. Clips of timelines may have played what it held. */
    async emptyBin() {
      if (!(await ask({ title: "Empty the bin?", text: "Everything in the bin is erased now, files and all, instead of after its 7 days. This cannot be undone.", yes: "Erase" }))) return;
      let erased = 0;
      if (await run("The bin could not be emptied", async () => { erased = (await api.emptyBin()).erased; })) {
        say({ id: `tree-empty:${Date.now()}`, tone: "good", title: `${erased} item${erased === 1 ? "" : "s"} erased` });
      }
    },
    /** A folder asked a name for, inside a folder, at the top of a project (in its root) or of the Inbox. Answers whether one was made. */
    async newFolder(where: { name: string; parent: string | null; project: string | null }) {
      const name = await askText({ title: `New folder in ${where.name}`, value: "", placeholder: "Folder name", yes: "Create" });
      if (!name) return false;
      return run(`${name} could not be made`, () => api.createFolder(name, where.parent, where.parent ? undefined : where.project));
    },
    /**
     * Where something brought in to a project, the Inbox or a folder lands: the folder itself, the project's
     * root folder (made first when it has none: `made`), or no folder for the Inbox. Undefined when it failed.
     */
    async landing(t: Target): Promise<{ folder: string | null; made: boolean } | undefined> {
      if (t.kind === "folder") return { folder: t.id, made: false };
      if (t.group === null) return { folder: null, made: false };
      if (t.root) return { folder: t.root, made: false };
      const group = t.group;
      let folder: string | null = null;
      if (!(await run(`${t.name} has no root folder yet`, async () => { folder = (await api.setProjectRoot(group)).folderId; }))) return undefined;
      return folder ? { folder, made: true } : undefined;
    },
    /**
     * A folder of the computer imported (copied) into a project, the Inbox or a folder, as the folder panel's
     * "Import a folder" does. Into the Inbox, the picked folder is made there first: the import makes the
     * folders it needs in the project the app looks at otherwise.
     */
    async importFolder(files: File[], t: Target, client: QueryClient) {
      if (!files.length) return;
      const at = await self.landing(t);
      if (!at) return;
      if (t.kind === "group" && t.group === null) {
        const top = pathOf(files[0]!)[0];
        if (top && !(await run(`${top} could not be made in the Inbox`, () => api.createFolder(top, null, null)))) return;
      }
      if (at.made) say({ id: `tree-root:${Date.now()}`, tone: "good", title: `${t.name} has a root folder now`, text: "The folder is imported into it.", href: "/", go: "Open the Studio" });
      await useFolderImport.getState().start(files, at.folder, client);
      refresh();
    },
    /** Files dropped from the computer: uploaded (pictures, videos, sounds) where they were dropped, into its directory for a folder of the disk. Folders dropped are not read. */
    upload(files: File[], t: Target, folders: number) {
      return bringFiles(files, { name: t.name, folders, onDisk: t.kind === "folder" ? t.linked : Boolean(t.rootLinked), landing: () => self.landing(t), say, done: refresh });
    },
    /** A folder of the disk linked to the top of a project or of the Inbox: used in place, nothing copied. */
    async link(t: Target) {
      const project = t.kind === "group" ? t.group : null;
      const path = await askText({ title: `Link a folder of your disk to ${t.name}`, value: "", placeholder: "Folder path, for example D:\\images\\shoots", yes: "Link" });
      if (!path) return;
      let made: { name: string; count: number; files?: number } | null = null;
      if (await run(`${path} could not be linked`, async () => { made = await api.linkFolder(path, undefined, project); })) {
        const m = made as { name: string; count: number; files?: number } | null;
        const n = m?.files ?? m?.count ?? 0;
        say({ id: `tree-link:${Date.now()}`, tone: "good", title: `${m?.name ?? path} linked: ${n} file${n === 1 ? "" : "s"}`, text: "Its files are used where they are; nothing was copied.", href: "/", go: "Open the Studio" });
      }
    },
    /** A folder of the disk whose directory is not found, pointed at where it is now: its files keep their places. */
    async relink(r: Row) {
      const id = r.id;
      if (!id) return;
      const path = await askText({ title: `Link ${r.label} again`, value: r.path ?? "", placeholder: "Where the folder is now, for example D:\images\shoots", yes: "Link again" });
      if (!path) return;
      if (await run(`${r.label} could not be linked again`, () => api.relinkFolder(id, path))) {
        say({ id: `tree-relink:${Date.now()}`, tone: "good", title: `${r.label} linked again`, text: "Its files kept their places in your timelines and folders.", href: "/", go: "Open the Studio" });
      }
    },
    /** A folder of the disk read again: what is new appears, what is gone goes. */
    async rescan(r: Row) {
      const id = r.id;
      if (!id) return;
      let found: { files: number; folders: number } | null = null;
      if (await run(`${r.label} could not be read`, async () => { found = await api.scanFolder(id); })) {
        const f = found as { files: number; folders: number } | null;
        say({ id: `tree-scan:${Date.now()}`, tone: "good", title: `${r.label} read again`, text: f ? `${f.files} file${f.files === 1 ? "" : "s"} in ${f.folders + 1} folder${f.folders ? "s" : ""}.` : undefined, href: "/", go: "Open the Studio" });
      }
    },
    /** A folder of the disk no longer shown. Nothing on the disk is touched. */
    async unlink(r: Row) {
      const id = r.id;
      if (!id || !r.linkedRoot) return;
      if (!(await askUnlink(r.label))) return;
      await run(`${r.label} could not be unlinked`, () => api.deleteFolder(id));
    },
    /**
     * A timeline's unused takes (no clip plays them, nothing else needs them) sent to the bin, once asked: the takes go, their
     * videos wait in the bin a week, and Undo in the timeline brings them back.
     */
    async binUnused(r: Row) {
      const id = r.id;
      const u = r.unused;
      if (!id || r.kind !== "timeline" || !u) return;
      const many = u.takes === 1 ? "take" : "takes";
      const text = `The ${many} no clip plays and nothing else needs go, and ${u.takes === 1 ? "its video goes" : "their videos go"} to the bin (${size(u.bytes)}): for a week they can be restored from it, and Undo in the timeline brings them back. The take each clip plays, and what it was made from, stay.`;
      if (!(await ask({ title: `Bin ${u.takes} unused ${many} of ${r.label}?`, text, yes: "Move to bin" }))) return;
      let done = { binned: 0, bytes: 0 };
      if (await run(`The unused takes of ${r.label} could not go to the bin`, async () => { done = await api.binUnusedTakes(id); })) {
        say({
          id: `tree-unused:${Date.now()}`, tone: "good", title: done.binned ? `${done.binned} unused take${done.binned === 1 ? "" : "s"} of ${r.label} moved to the bin` : `${r.label} has no unused takes left`,
          text: done.binned ? `${size(done.bytes)}: for a week they can be restored from the bin, or Undo in the timeline.` : undefined, href: `/timelines/${id}`, go: "Open the timeline",
        });
      }
    },
    /** A group's unused drafts (no prompt, no name, no conversation, nothing made from them) deleted; the open one stays. Asked in place on their row first (TwoStep), as the Studio's draft menu does. */
    async clearEmpty(group: string | null, where: string, keep: string | null) {
      await run(`The empty drafts of ${where} could not be cleared`, () => api.clearUnusedDraftsOf(group, keep ?? undefined));
    },
    /** A project's root folder: that folder, or a new one named after it. */
    async setRoot(project: { id: string; name: string }, folder?: { id: string; name: string }) {
      if (await run(`${project.name} has no root folder yet`, () => api.setProjectRoot(project.id, folder?.id))) {
        say({ id: `tree-root:${Date.now()}`, tone: "good", title: folder ? `${folder.name} is ${project.name}'s root folder` : `${project.name} has a root folder`, text: "What is made in it lands there unless another of its folders is open.", href: "/", go: "Open the Studio" });
      }
    },
  };
  return self;
}
