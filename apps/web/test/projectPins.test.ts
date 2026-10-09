import { describe, expect, it } from "vitest";
import type { Folder } from "../src/api";
import { migrateProject } from "../src/project";
import { livePins, movePin } from "../src/projects/pins";
import { crumbsOf, foldCrumbs } from "../src/screens/library/FolderPanel";

describe("the project worked in", () => {
  it("moves a browser left on the old All (null) to the Inbox, and keeps a project or the Inbox as they were", () => {
    expect(migrateProject({ id: null })).toEqual({ id: "none" });
    expect(migrateProject(undefined)).toEqual({ id: "none" });
    expect(migrateProject({ id: "" })).toEqual({ id: "none" });
    expect(migrateProject({ id: "p1" })).toEqual({ id: "p1" });
    expect(migrateProject({ id: "none" })).toEqual({ id: "none" });
  });
});

describe("the rail's pins", () => {
  const projects = [{ id: "a", archivedAt: null }, { id: "b", archivedAt: "2026-10-01" }, { id: "c", archivedAt: null }, { id: "d", archivedAt: null }, { id: "e", archivedAt: null }];
  it("keep only places to switch to: no archived or deleted project, each once, the Inbox always, four at most", () => {
    expect(livePins(["c", "b", "gone", "none", "a", "c"], projects)).toEqual(["c", "none", "a"]);
    expect(livePins(["a", "c", "d", "e", "none"], projects)).toEqual(["a", "c", "d", "e"]);
    // the projects not read yet: the pins as saved, rather than none for a moment
    expect(livePins(["x", "y"], undefined)).toEqual(["x", "y"]);
  });
  it("are dragged to a new place: before the pin dropped on, or after the last", () => {
    expect(movePin(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(movePin(["a", "b", "c", "d"], "a", 4)).toEqual(["b", "c", "d", "a"]);
    expect(movePin(["a", "b", "c", "d"], "a", 2)).toEqual(["b", "a", "c", "d"]);
    expect(movePin(["a", "b", "c", "d"], "c", 1)).toEqual(["a", "c", "b", "d"]);
    // dropped where it is: nothing moves
    expect(movePin(["a", "b", "c"], "b", 1)).toEqual(["a", "b", "c"]);
    expect(movePin(["a", "b", "c"], "b", 2)).toEqual(["a", "b", "c"]);
  });
});

describe("the library's breadcrumb", () => {
  const f = (id: string, parentId: string | null, name = id): Folder => ({ id, parentId, name, count: 0, path: null, root: false, projectId: "show" }) as Folder;
  const folders = [f("root", null, "Showcase"), f("bigair", "root", "Big Air"), f("keys", "bigair", "Keyframes"), f("v1", "keys", "v1"), f("loose", null, "Loose")];
  const labels = (place: Parameters<typeof crumbsOf>[0]) => crumbsOf(place, "Showcase", "root", folders).map((c) => c.label);
  it("says the path inside the project, the root folder left out (the project's crumb stands for it)", () => {
    expect(labels({ type: "all" })).toEqual(["Showcase"]);
    expect(labels({ type: "folder", id: "keys" })).toEqual(["Showcase", "Big Air", "Keyframes"]);
    expect(labels({ type: "folder", id: "loose" })).toEqual(["Showcase", "Loose"]);
    expect(labels({ type: "folder", id: "root" })).toEqual(["Showcase", "root folder"]);
    expect(labels({ type: "bin" })).toEqual(["Showcase", "Bin"]);
    expect(labels({ type: "unfiled" })).toEqual(["Showcase", "No folder"]);
    // a folder not read yet waits, rather than a wrong path
    expect(labels({ type: "folder", id: "new" })).toEqual(["Showcase", "…"]);
  });
  it("goes to the whole project from its first crumb, to each folder from its own", () => {
    const crumbs = crumbsOf({ type: "folder", id: "keys" }, "Showcase", "root", folders);
    expect(crumbs.map((c) => c.place)).toEqual([{ type: "all" }, { type: "folder", id: "bigair" }, { type: "folder", id: "keys" }]);
  });
  it("folds the middle crumbs of a long path into …", () => {
    const crumbs = crumbsOf({ type: "folder", id: "v1" }, "Showcase", "root", folders).map((c) => c.label);
    expect(crumbs).toEqual(["Showcase", "Big Air", "Keyframes", "v1"]);
    expect(foldCrumbs(crumbs)).toEqual(["Showcase", "…", "Keyframes", "v1"]);
    expect(foldCrumbs(["Showcase", "Big Air", "Keyframes"])).toEqual(["Showcase", "Big Air", "Keyframes"]);
  });
});
