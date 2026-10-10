import { describe, expect, it } from "vitest";
import type { QueryKey } from "@tanstack/react-query";
import { libraryInPlace, libraryReads, type LibraryChange } from "../src/queryKeys";

/** The queries a page can have under the library's keys, by name, as data.ts and the screens key them. */
const KEYS: Record<string, QueryKey> = {
  studio: ["assets", "list", "none", { all: false }, true],
  searched: ["assets", "list", "none", { q: "cat" }, false],
  folderA: ["assets", "list", "p1", { folder: "A" }, false],
  folderB: ["assets", "list", "p1", { folder: "B" }, false],
  loose: ["assets", "list", "none", { folder: "none" }, false],
  keptOnly: ["assets", "list", "none", { kept: true }, true],
  bin: ["assets", "list", "none", { bin: true }, true],
  treeA: ["assets", "tree", "A", null, 1, "created", true],
  treeAByName: ["assets", "tree", "A", null, 1, "name", false],
  treeB: ["assets", "tree", "B", null, 1, "created", true],
  item1: ["assets", "one", "i1"],
  item2: ["assets", "one", "i2"],
  unkept: ["assets", "unkept", "all", "none"],
  folders: ["folders"],
  storage: ["storage"],
  projects: ["projects"],
  projectsTree: ["projects", "tree", "", null],
  families: ["facets", "families"],
  models: ["facets", "models"],
  queue: ["queue"],
  backupPlan: ["backup-plan"],
};
/** The names of the queries a run of changes reads again. */
const read = (...changes: Array<LibraryChange | null>) => {
  const reads = libraryReads(changes);
  return Object.keys(KEYS).filter((name) => reads(KEYS[name]!));
};
const EVERY = Object.keys(KEYS).filter((n) => n !== "queue" && n !== "backupPlan");

describe("a library event on the page", () => {
  it("reads every list when it says nothing, or a change this page does not know", () => {
    expect(read({})).toEqual(EVERY);
    expect(read(null)).toEqual(EVERY);
    expect(read({ change: "repainted" } as unknown as LibraryChange)).toEqual(EVERY);
  });

  it("writes a rename in place and reads again only what is found or ordered by the name", () => {
    const c: LibraryChange = { change: "fields", items: ["i1"], name: "zz-test new" };
    expect(libraryInPlace(c)).toEqual({ kind: "rename", ids: ["i1"], name: "zz-test new" });
    expect(read(c)).toEqual(["searched", "treeAByName"]);
    // a name cleared, or a size read: the lists of items and that item's details, nothing counted
    expect(libraryInPlace({ ...c, name: "" })).toBeNull();
    expect(read({ change: "fields", items: ["i1"] })).toEqual(["studio", "searched", "folderA", "folderB", "loose", "keptOnly", "bin", "treeA", "treeAByName", "treeB", "item1"]);
  });

  it("writes a keep in place and reads the kept lists, the expiring count and the disk use", () => {
    const c: LibraryChange = { change: "kept", items: ["i1"], kept: true };
    expect(libraryInPlace(c)).toEqual({ kind: "keep", ids: ["i1"], kept: true });
    expect(read(c)).toEqual(["keptOnly", "unkept", "storage"]);
    // not said which: the item is read again with the lists
    expect(read({ change: "kept", items: ["i1"] })).toContain("item1");
  });

  it("reads after a render only the lists of the folders it filed into, and the counts", () => {
    const loose = read({ change: "added", items: ["n1", "n2"], folders: [null] });
    expect(loose).toEqual(["studio", "searched", "loose", "keptOnly", "bin", "unkept", "storage", "projects", "projectsTree", "families", "models"]);
    // no item's details, no folder counts when nothing went into a folder, no other folder's list
    expect(read({ change: "added", items: ["n1"], folders: ["A"] })).toEqual(expect.arrayContaining(["folderA", "treeA", "folders"]));
    expect(read({ change: "added", items: ["n1"], folders: ["A"] })).not.toContain("treeB");
  });

  it("reads after a move the two folders, the moved items, the counts; the disk use only when filing kept them", () => {
    const c: LibraryChange = { change: "moved", items: ["i1"], folders: ["A", "B"], kept: false };
    expect(read(c)).toEqual(["studio", "searched", "folderA", "folderB", "keptOnly", "bin", "treeA", "treeAByName", "treeB", "item1", "unkept", "folders", "projects", "projectsTree"]);
    expect(read({ ...c, kept: true })).toContain("storage");
  });

  it("reads after a bin what the items leave and the bin; after an erase the bin and the disk use alone", () => {
    expect(read({ change: "binned", items: ["i1"], folders: ["B"] })).toEqual(["studio", "searched", "folderB", "keptOnly", "bin", "treeB", "item1", "unkept", "folders", "storage", "projects", "projectsTree", "families", "models"]);
    expect(read({ change: "erased", items: ["i2"] })).toEqual(["bin", "item2", "storage"]);
  });

  it("reads after a project made or renamed the places alone", () => {
    expect(read({ change: "places" })).toEqual(["folders", "projects", "projectsTree"]);
  });

  it("gathers the changes of several events read in one go", () => {
    expect(read({ change: "places" }, { change: "erased", items: ["i2"] })).toEqual(["bin", "item2", "folders", "storage", "projects", "projectsTree"]);
    expect(read({ change: "places" }, {})).toEqual(EVERY);
  });
});
