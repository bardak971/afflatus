import { useLocation } from "wouter";
import type { Asset } from "../api";
import { useHandover, useOpenDraft, useStudio, type Place } from "../store";
import type { Row } from "./tree";

/**
 * What a row of the Projects panel does when it is clicked (or Enter is pressed on it): switch to the project, open what
 * it is (a folder in the Studio, a timeline, a draft, an item in the Viewer), read a list further, or fold it. In one
 * project's tree, the rows are places of the library instead.
 */
export function useRowActivate({ scope, current, setProject, toggle, readMore, onView, onClose }: {
  scope: { onPlace(p: Place): void } | undefined;
  /** The project worked in ("none": the Inbox). */
  current: string;
  setProject(id: string | null): void;
  toggle(r: Row): void;
  /** A "more" row's list read further. */
  readMore(more: string): void;
  onView(asset: Asset): void;
  onClose(): void;
}) {
  const [, go] = useLocation();
  /** One project's tree: a place of the library chosen, and the tree closed. */
  const toPlace = (p: Place) => {
    scope?.onPlace(p);
    onClose();
  };

  /** What a plain click (or Enter) does: switch to it, open it, or fold it. */
  const activate = (r: Row) => {
    if (scope && (r.kind === "inbox" || r.kind === "project")) return toPlace({ type: "all" });
    if (r.kind === "loose") return toPlace({ type: "unfiled" });
    if (r.kind === "inbox") return setProject("none");
    if (r.kind === "project") return r.archived ? toggle(r) : setProject(r.id);
    if (r.kind === "archive" || r.kind === "drafts" || r.kind === "empty") return toggle(r);
    if (r.kind === "more") {
      const more = r.more;
      if (!more) return;
      readMore(more);
      return;
    }
    if (r.kind === "item") return r.asset && onView(r.asset);
    if (r.kind === "bin") {
      if (scope) return toPlace({ type: "bin" });
      useStudio.getState().set({ place: { type: "bin" } });
      onClose();
      return go("/");
    }
    if (r.kind === "folder") return openFolder(r.id!, r.group);
    if (r.kind === "timeline") {
      onClose();
      return go(`/timelines/${r.id}`);
    }
    if (r.kind === "draft") {
      useOpenDraft.getState().open(r.id);
      useStudio.getState().set({ form: true, scope: "draft" });
      onClose();
      go("/");
    }
  };
  /** The Studio on a folder: the app works in its project when it worked in another one (else the Studio would leave it). In one project's tree: that place of the library, where it is. */
  const openFolder = (id: string, group: string | null) => {
    if (scope) return toPlace({ type: "folder", id });
    if (current !== (group ?? "none")) setProject(group ?? "none");
    useStudio.getState().set({ place: { type: "folder", id } });
    onClose();
    go("/");
  };
  /** An item shown in the Studio: its folder open (the Inbox's loose items: "in no folder"), the item large. */
  const showInStudio = (a: Asset, group: string | null) => {
    if (current !== (group ?? "none")) setProject(group ?? "none");
    useStudio.getState().set({ place: a.folderId ? { type: "folder", id: a.folderId } : { type: "unfiled" } });
    useHandover.getState().set({ show: a.id });
    onClose();
    go("/");
  };
  const targetOf = (r: Row): (() => void) | undefined => (r.kind === "folder" && r.id ? () => openFolder(r.id!, r.group) : r.kind === "project" && !r.archived ? () => setProject(r.id) : r.kind === "inbox" ? () => setProject("none") : undefined);
  return { activate, showInStudio, targetOf };
}
