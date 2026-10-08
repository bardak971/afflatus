import { describe, expect, it } from "vitest";
import type { Asset, FolderNode, ProjectsTree, TreeGroup } from "../src/api/types/library";
import { flatten, folderMeta, itemLabel, itemMeta, planBin, planDrop, rangePick, step, type Moving, type Target } from "../src/projects/tree";

const folder = (id: string, children: FolderNode[] = [], linked = false): FolderNode => ({ id, name: id, linked, items: 1, totalItems: 1 + children.length, bytes: 2 ** 20, children });
const group = (id: string | null, over: Partial<TreeGroup> = {}): TreeGroup => ({
  id, kind: id ? "project" : "inbox", name: id ?? "Inbox", archived: false, rootFolderId: id ? `root-${id}` : null,
  counts: { drafts: 0, timelines: 0, items: 0 }, bytes: 0, folders: [], timelines: [], ...over,
});
const tree: ProjectsTree = {
  totalBytes: 10,
  groups: [
    group(null, { folders: [folder("harbor")], timelines: [{ id: "box", name: "Harbor walk", folderId: null, clips: 4, durationMs: 20_000, bytes: 1, exported: true, updatedAt: "" }] }),
    group("dev", { rootFolderId: null, folders: [folder("orange"), folder("parrot", [folder("closeups")])], counts: { drafts: 3, timelines: 0, items: 2 } }),
    group("old", { archived: true }),
  ],
};
const none = () => undefined;

describe("the tree as rows", () => {
  it("shows the top rows folded: All, the Inbox, the projects, then the archived ones", () => {
    const rows = flatten(tree, { isOpen: () => false, drafts: none });
    expect(rows.map((r) => r.key)).toEqual(["all", "g:inbox", "g:dev", "archived"]);
    expect(rows.every((r) => r.prefix === "")).toBe(true);
    expect(rows.find((r) => r.key === "g:dev")?.noRoot).toBe(true);
    expect(rows.find((r) => r.key === "archived")?.label).toBe("Archived (1)");
  });
  it("draws the branches like the tree command", () => {
    const rows = flatten(tree, { isOpen: () => true, items: () => ({ items: [], more: false }), drafts: (k) => (k === "d:dev" ? { items: [{ id: "x", title: "a cat", name: null, recipe: "r", updatedAt: "" }], limit: 50 } : undefined) });
    const dev = rows.slice(rows.findIndex((r) => r.key === "g:dev"), rows.findIndex((r) => r.key === "archived"));
    expect(dev.map((r) => `${r.prefix}${r.label}`)).toEqual(["dev", "├─ orange", "├─ parrot", "│  └─ closeups", "└─ Drafts · 3", "   └─ a cat"]);
    expect(rows.find((r) => r.key === "f:closeups")?.parent).toBe("f:parrot");
    expect(rows.find((r) => r.key === "t:box")?.meta).toBe("4 clips · 0:20 · exported");
  });
  it("shows a timeline filed in a folder inside it, after its sub-folders; one in no folder under the group", () => {
    const filed: ProjectsTree = {
      totalBytes: 1,
      groups: [group("dev", {
        folders: [folder("parrot", [folder("closeups")])],
        timelines: [
          { id: "in", name: "Parrot cut", folderId: "parrot", clips: 2, durationMs: 9000, bytes: 1, exported: false, updatedAt: "" },
          { id: "out", name: "Loose cut", folderId: null, clips: 1, durationMs: 4000, bytes: 1, exported: false, updatedAt: "" },
        ],
      })],
    };
    const rows = flatten(filed, { isOpen: () => true, items: () => ({ items: [], more: false }), drafts: none });
    const dev = rows.slice(rows.findIndex((r) => r.key === "g:dev"));
    expect(dev.map((r) => `${r.prefix}${r.label}`).slice(0, 5)).toEqual(["dev", "├─ parrot", "│  ├─ closeups", "│  └─ Parrot cut", "└─ Loose cut"]);
    expect(rows.find((r) => r.key === "t:in")?.parent).toBe("f:parrot");
  });

  it("says the drafts are being read, then shows 50 and a Show more", () => {
    const open = (k: string) => k === "g:dev" || k === "d:dev";
    expect(flatten(tree, { isOpen: open, drafts: none }).at(-2)?.label).toBe("Reading…");
    const items = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, title: `d${i}`, name: null, recipe: "r", updatedAt: "" }));
    const rows = flatten(tree, { isOpen: open, drafts: () => ({ items, limit: 50 }) });
    expect(rows.filter((r) => r.kind === "draft")).toHaveLength(50);
    expect(rows.find((r) => r.kind === "more")).toMatchObject({ label: "Show more", meta: "10 more" });
  });
  it("marks matches and fades what holds none while searching", () => {
    const rows = flatten(tree, { isOpen: () => true, drafts: none, q: "Harbor" });
    expect(rows.find((r) => r.key === "f:harbor")).toMatchObject({ match: true, faded: false });
    expect(rows.find((r) => r.key === "g:inbox")).toMatchObject({ match: false, faded: false });
    expect(rows.find((r) => r.key === "g:dev")?.faded).toBe(true);
  });
});

const asset = (id: string, over: Partial<Asset> = {}): Asset => ({
  id, kind: "image", origin: "made", name: "", mime: "image/png", bytes: 1, width: 832, height: 1216, durationMs: null, fps: null, hasSound: false,
  kept: false, inBin: false, folderId: null, generationId: null, createdAt: "", path: null, ...over,
});

describe("a folder's items", () => {
  const open = (k: string) => k === "g:inbox" || k === "f:harbor";
  it("are read when the folder unfolds, then shown after its folders, with a Show more", () => {
    expect(flatten(tree, { isOpen: open, drafts: none }).find((r) => r.parent === "f:harbor")?.label).toBe("Reading…");
    const rows = flatten(tree, { isOpen: open, drafts: none, items: () => ({ items: [asset("a1"), asset("a2", { kind: "video", name: "walk", durationMs: 5000 })], more: true }) });
    const under = rows.filter((r) => r.parent === "f:harbor");
    expect(under.map((r) => `${r.prefix}${r.label}`)).toEqual(["│  ├─ Image", "│  ├─ walk", "│  └─ Show more"]);
    expect(under[2]!.more).toBe("f:harbor");
    expect(under[0]!.moving).toEqual({ kind: "asset", id: "a1", folder: "harbor", name: "Image" });
  });
  it("do not show while searching", () => {
    const rows = flatten(tree, { isOpen: () => true, drafts: none, q: "harbor", items: () => ({ items: [asset("a1")], more: false }) });
    expect(rows.some((r) => r.kind === "item")).toBe(false);
    expect(rows.find((r) => r.key === "f:harbor")?.foldable).toBe(false);
  });
  it("say what they are", () => {
    expect(itemLabel(asset("x", { kind: "audio" }))).toBe("Sound");
    expect(itemMeta(asset("x"))).toBe("image · 832×1216");
    expect(itemMeta(asset("x", { kind: "video", durationMs: 65_000 }))).toBe("video · 1:05");
  });
  it("end the tree with the Bin, searching or not", () => {
    expect(flatten(tree, { isOpen: () => false, drafts: none, bin: { count: 3, bytes: 9 } }).at(-1)).toMatchObject({ key: "bin", meta: "3 items · kept a week" });
    expect(flatten(tree, { isOpen: () => false, drafts: none, bin: { count: 3, bytes: 9 }, q: "x" }).at(-1)).toMatchObject({ key: "bin" });
  });
});

describe("picking a range", () => {
  const order = ["a", "b", "c", "d", "e"];
  it("takes the rows between, either way", () => {
    expect(rangePick(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangePick(order, "d", "b")).toEqual(["b", "c", "d"]);
  });
  it("keeps only what can be picked, and starts alone without a last one", () => {
    expect(rangePick(order, "a", "e", (k) => k !== "c")).toEqual(["a", "b", "d", "e"]);
    expect(rangePick(order, null, "c")).toEqual(["c"]);
    expect(rangePick(order, "gone", "c")).toEqual(["c"]);
  });
  it("walks the rows with the arrows, staying inside", () => {
    const rows = flatten(tree, { isOpen: () => false, drafts: none });
    expect(step(rows, null, 1)).toBe("all");
    expect(step(rows, "all", -1)).toBe("all");
    expect(step(rows, "g:inbox", 1)).toBe("g:dev");
  });
});

describe("what a drop does", () => {
  const parrot: Moving = { kind: "folder", id: "parrot", group: "dev", parent: null, name: "parrot" };
  const closeups: Target = { kind: "folder", id: "closeups", group: "dev", linked: false, ancestors: ["parrot"], name: "closeups" };
  const orange: Target = { kind: "folder", id: "orange", group: "dev", linked: false, ancestors: [], name: "orange" };
  const inbox: Target = { kind: "group", group: null, root: null, name: "the Inbox" };
  const withRoot: Target = { kind: "group", group: "p", root: "root-p", name: "P" };
  const noRoot: Target = { kind: "group", group: "q", root: null, name: "Q" };
  const timeline: Moving = { kind: "timeline", id: "t", group: "dev", folder: "orange", name: "t" };
  const draft: Moving = { kind: "draft", id: "d", group: "dev", name: "d" };

  it("refuses a folder into itself or one under it, and anything onto a folder of the disk", () => {
    expect(planDrop([parrot], closeups)).toBeNull();
    expect(planDrop([parrot], { ...orange, id: "parrot" })).toBeNull();
    expect(planDrop([timeline], { ...orange, id: "disk", linked: true })).toBeNull();
  });
  it("refuses a draft onto a folder, and a drop that moves nothing", () => {
    expect(planDrop([draft], orange)).toBeNull();
    expect(planDrop([timeline, draft], { ...orange, id: "x" })).toBeNull();
    expect(planDrop([timeline], orange)).toBeNull();
    expect(planDrop([draft], { kind: "group", group: "dev", root: null, name: "dev" })).toBeNull();
    expect(planDrop([], inbox)).toBeNull();
  });
  it("moves a folder into a project's root, the top of a project without one, or the Inbox", () => {
    expect(planDrop([parrot], withRoot)).toEqual([{ kind: "folder", id: "parrot", patch: { parentId: "root-p" } }]);
    expect(planDrop([parrot], noRoot)).toEqual([{ kind: "folder", id: "parrot", patch: { parentId: null, project: "q" } }]);
    expect(planDrop([parrot], inbox)).toEqual([{ kind: "folder", id: "parrot", patch: { parentId: null, project: null } }]);
    expect(planDrop([parrot], orange)).toEqual([{ kind: "folder", id: "parrot", patch: { parentId: "orange" } }]);
  });
  it("moves timelines with their project and folder, drafts with their project", () => {
    expect(planDrop([timeline, draft], noRoot)).toEqual([
      { kind: "timeline", id: "t", patch: { project: "q", folder: null } },
      { kind: "draft", id: "d", project: "q" },
    ]);
    expect(planDrop([timeline], { ...closeups })).toEqual([{ kind: "timeline", id: "t", patch: { project: "dev", folder: "closeups" } }]);
    // already at the top of its own project: only the others move
    expect(planDrop([{ ...timeline, folder: null }, draft], inbox)).toHaveLength(2);
    expect(planDrop([{ ...timeline, folder: null }], { kind: "group", group: "dev", root: null, name: "dev" })).toBeNull();
  });
});

describe("items dropped", () => {
  const item: Moving = { kind: "asset", id: "a", folder: "orange", name: "a" };
  it("go into a folder, or a project's root folder", () => {
    expect(planDrop([item], { kind: "folder", id: "parrot", group: "dev", linked: false, ancestors: [], name: "parrot" })).toEqual([{ kind: "asset", id: "a", folder: "parrot" }]);
    expect(planDrop([item], { kind: "group", group: "p", root: "root-p", name: "P" })).toEqual([{ kind: "asset", id: "a", folder: "root-p" }]);
  });
  it("are refused by a project without a root folder, the Inbox, and where they already are; a folder of the disk takes them", () => {
    expect(planDrop([item], { kind: "group", group: "q", root: null, name: "Q" })).toBeNull();
    expect(planDrop([item], { kind: "group", group: null, root: null, name: "the Inbox" })).toBeNull();
    expect(planDrop([item], { kind: "folder", id: "disk", group: null, linked: true, ancestors: [], name: "disk" })).toEqual([{ kind: "asset", id: "a", folder: "disk" }]);
    expect(planDrop([item], { kind: "folder", id: "orange", group: "dev", linked: false, ancestors: [], name: "orange" })).toBeNull();
  });
});

describe("a drop on the Bin", () => {
  it("bins items and deletes the rest", () => {
    expect(planBin([
      { kind: "asset", id: "a", folder: null, name: "a" },
      { kind: "folder", id: "f", group: null, parent: null, name: "f" },
      { kind: "timeline", id: "t", group: null, folder: null, name: "t" },
      { kind: "draft", id: "d", group: null, name: "d" },
    ])).toEqual({ assets: ["a"], folders: ["f"], timelines: ["t"], drafts: ["d"] });
  });
  it("takes nothing when nothing is dragged (projects never are)", () => {
    expect(planBin([])).toBeNull();
  });
});

describe("folders of the disk", () => {
  const disk: FolderNode = { ...folder("shoots", [folder("day1", [], true)], true) };
  const linkedTree: ProjectsTree = { totalBytes: 0, groups: [group(null, { folders: [disk] }), group("dev", { folders: [folder("orange")] })] };
  const rows = flatten(linkedTree, { isOpen: () => true, drafts: none, items: () => ({ items: [], more: false }) });
  const root = rows.find((r) => r.key === "f:shoots")!;
  const sub = rows.find((r) => r.key === "f:day1")!;
  const dev: Target = { kind: "group", group: "dev", root: "root-dev", name: "dev" };
  const orange: Target = { kind: "folder", id: "orange", group: "dev", linked: false, ancestors: [], name: "orange" };

  it("move as a whole: the linked one does, its sub-folders never", () => {
    expect(root).toMatchObject({ linked: true, linkedRoot: true });
    expect(root.moving).toMatchObject({ kind: "folder", linkedRoot: true });
    expect(sub.linkedRoot).toBe(false);
    expect(sub.moving).toBeUndefined();
  });
  it("change project at its top, never nest", () => {
    expect(planDrop([root.moving!], dev)).toEqual([{ kind: "folder", id: "shoots", patch: { project: "dev" } }]);
    expect(planDrop([root.moving!], { kind: "group", group: null, root: null, name: "the Inbox" })).toBeNull();
    expect(planDrop([root.moving!], orange)).toBeNull();
  });
  it("take items, but no folder, timeline or draft", () => {
    const item: Moving = { kind: "asset", id: "a", folder: "orange", name: "a" };
    expect(planDrop([item], root.target!)).toEqual([{ kind: "asset", id: "a", folder: "shoots" }]);
    expect(planDrop([{ kind: "folder", id: "orange", group: "dev", parent: null, name: "orange" }], root.target!)).toBeNull();
    expect(planDrop([{ kind: "timeline", id: "t", group: "dev", folder: null, name: "t" }], root.target!)).toBeNull();
  });
  it("keep their files on the disk: those go only to another folder of the disk", () => {
    const file: Moving = { kind: "asset", id: "f", folder: "shoots", name: "f", onDisk: true };
    expect(planDrop([file], orange)).toBeNull();
    expect(planDrop([file], dev)).toBeNull();
    expect(planDrop([file], sub.target!)).toEqual([{ kind: "asset", id: "f", folder: "day1" }]);
  });
});

describe("one kind of item shown", () => {
  it("says the folders' counts in that kind", () => {
    expect(folderMeta({ items: 4, totalItems: 4, linked: false }, "video")).toBe("4 videos");
    expect(folderMeta({ items: 1, totalItems: 1, linked: true }, "audio")).toBe("1 sound · on your disk");
    expect(folderMeta({ items: 2, totalItems: 5, linked: false }, "image")).toBe("2 here · 5 images in all");
    expect(folderMeta({ items: 3, totalItems: 3, linked: false })).toBe("3 items");
  });
  it("fades the folders that hold none of it, and only those", () => {
    const none: FolderNode = { ...folder("empty"), items: 0, totalItems: 0 };
    const some = folder("some");
    const kindTree: ProjectsTree = { totalBytes: 0, groups: [group(null, { folders: [none, some] })] };
    const rows = flatten(kindTree, { isOpen: () => true, drafts: () => undefined, items: () => ({ items: [], more: false }), kind: "video" });
    expect(rows.find((r) => r.key === "f:empty")?.faded).toBe(true);
    expect(rows.find((r) => r.key === "f:some")?.faded).toBeFalsy();
    expect(rows.find((r) => r.key === "g:inbox")?.faded).toBeFalsy();
    expect(rows.find((r) => r.key === "f:empty")?.foldable).toBe(false);
  });
  it("fades with the search too: both apply", () => {
    const none: FolderNode = { ...folder("harbor two"), items: 0, totalItems: 0 };
    const kindTree: ProjectsTree = { totalBytes: 0, groups: [group(null, { folders: [none, folder("other")] })] };
    const rows = flatten(kindTree, { isOpen: () => true, drafts: () => undefined, q: "harbor", kind: "image" });
    expect(rows.find((r) => r.key === "f:harbor two")).toMatchObject({ match: true, faded: true });
    expect(rows.find((r) => r.key === "f:other")?.faded).toBe(true);
  });
});
