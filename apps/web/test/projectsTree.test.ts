import { describe, expect, it } from "vitest";
import type { Asset, FolderNode, ProjectsTree, TreeGroup } from "../src/api/types/library";
import { flatten, folderMeta, pathEnd, whyRefused, itemLabel, itemMeta, itemsOrder, nextSort, planBin, planDrop, rangePick, shortDate, step, type Moving, type Target } from "../src/projects/tree";

const folder = (id: string, children: FolderNode[] = [], linked = false): FolderNode => ({ id, name: id, linked, items: 1, totalItems: 1 + children.length, bytes: 2 ** 20, children });
const group = (id: string | null, over: Partial<TreeGroup> = {}): TreeGroup => ({
  id, kind: id ? "project" : "inbox", name: id ?? "Inbox", archived: false, rootFolderId: id ? `root-${id}` : null,
  counts: { drafts: 0, timelines: 0, items: 0 }, bytes: 0, folders: [], timelines: [], ...over,
});
const tree: ProjectsTree = {
  totalBytes: 10,
  groups: [
    group(null, { folders: [folder("harbor")], timelines: [{ id: "box", name: "Harbor walk", folderId: null, clips: 4, durationMs: 20_000, bytes: 1, exported: true, unusedTakes: 0, unusedBytes: 0, createdAt: "", updatedAt: "" }] }),
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
          { id: "in", name: "Parrot cut", folderId: "parrot", clips: 2, durationMs: 9000, bytes: 1, exported: false, unusedTakes: 0, unusedBytes: 0, createdAt: "", updatedAt: "" },
          { id: "out", name: "Loose cut", folderId: null, clips: 1, durationMs: 4000, bytes: 1, exported: false, unusedTakes: 0, unusedBytes: 0, createdAt: "", updatedAt: "" },
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
    // the name worked out from where it came from goes before an own name that says nothing
    expect(itemLabel(asset("x", { name: "video · 0:01–0:02", shownName: "Big Air · c2 · t5 · 0:01–0:02" }))).toBe("Big Air · c2 · t5 · 0:01–0:02");
    expect(itemLabel(asset("x", { name: "Harbor walk" }))).toBe("Harbor walk");
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
    expect(folderMeta({ items: 1, totalItems: 1, linked: true }, "audio")).toBe("1 sound");
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

describe("the columns", () => {
  const leaf = (id: string, name: string, createdAt: string, bytes: number, folderId: string | null = null) =>
    ({ id, name, folderId, clips: 1, durationMs: 4000, bytes, exported: false, unusedTakes: 0, unusedBytes: 0, createdAt, updatedAt: createdAt });
  const sized = (id: string, bytes: number, children: FolderNode[] = []): FolderNode => ({ id, name: id, linked: false, items: 1, totalItems: 1, bytes, children });
  const sorted: ProjectsTree = {
    totalBytes: 1,
    groups: [group("p", {
      folders: [sized("beta", 10), sized("Alpha", 30), sized("gamma", 20)],
      timelines: [leaf("t1", "Harbor walk", "2026-10-01T10:00:00Z", 5), leaf("t2", "pier", "2026-10-03T10:00:00Z", 1), leaf("t3", "Dunes", "2026-10-02T10:00:00Z", 9)],
      counts: { drafts: 3, timelines: 3, items: 3 },
    })],
  };
  const drafts = [
    { id: "x", title: "zebra", name: null, recipe: "r", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" },
    { id: "y", title: "apple", name: null, recipe: "r", createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" },
    { id: "z", title: "mango", name: null, recipe: "r", updatedAt: "2026-10-02T00:00:00Z" },
  ];
  const order = (sort?: { by: "name" | "created" | "size"; desc: boolean }) =>
    flatten(sorted, { isOpen: () => true, items: () => ({ items: [], more: false }), drafts: () => ({ items: drafts, limit: 50 }), ...(sort ? { sort } : {}) })
      .filter((r) => r.group === "p" && r.depth > 0)
      .map((r) => r.label);

  it("sort each level newest first by default, folders first by name", () => {
    expect(order()).toEqual(["Alpha", "beta", "gamma", "pier", "Dunes", "Harbor walk", "Drafts · 3", "apple", "mango", "zebra"]);
  });
  it("sort by name either way, folders too", () => {
    expect(order({ by: "name", desc: false })).toEqual(["Alpha", "beta", "gamma", "Dunes", "Harbor walk", "pier", "Drafts · 3", "apple", "mango", "zebra"]);
    expect(order({ by: "name", desc: true })).toEqual(["gamma", "beta", "Alpha", "pier", "Harbor walk", "Dunes", "Drafts · 3", "zebra", "mango", "apple"]);
  });
  it("sort by size with the folders by their bytes too; drafts, sizeless, keep their order", () => {
    expect(order({ by: "size", desc: true })).toEqual(["Alpha", "gamma", "beta", "Dunes", "Harbor walk", "pier", "Drafts · 3", "zebra", "apple", "mango"]);
    expect(order({ by: "created", desc: false })).toEqual(["Alpha", "beta", "gamma", "Harbor walk", "Dunes", "pier", "Drafts · 3", "zebra", "mango", "apple"]);
  });
  it("turn around on a second click; a new column starts A to Z, newest or largest first", () => {
    expect(nextSort({ by: "created", desc: true }, "created")).toEqual({ by: "created", desc: false });
    expect(nextSort({ by: "created", desc: true }, "name")).toEqual({ by: "name", desc: false });
    expect(nextSort({ by: "name", desc: false }, "size")).toEqual({ by: "size", desc: true });
    expect(itemsOrder({ by: "created", desc: true })).toEqual({ sort: "new" });
    expect(itemsOrder({ by: "created", desc: false })).toEqual({ sort: "old" });
    expect(itemsOrder({ by: "size", desc: false })).toEqual({ sort: "size", dir: "asc" });
  });
  it("say when it was made, short", () => {
    const now = new Date(2026, 9, 8, 15, 0);
    expect(shortDate(new Date(2026, 9, 8, 14, 32).toISOString(), now)).toBe("14:32");
    expect(shortDate(new Date(2026, 9, 7, 23, 59).toISOString(), now)).toBe("yesterday");
    expect(shortDate(new Date(2026, 9, 3, 9, 0).toISOString(), now)).toBe("3 Oct");
    expect(shortDate(new Date(2025, 9, 3, 9, 0).toISOString(), now)).toBe("3 Oct 2025");
    const rows = flatten(sorted, { isOpen: () => true, items: () => ({ items: [], more: false }), drafts: () => ({ items: drafts, limit: 50 }) });
    expect(rows.find((r) => r.key === "t:t1")?.created).toBe("2026-10-01T10:00:00Z");
    expect(rows.find((r) => r.key === "dr:x")?.created).toBe("2026-10-01T00:00:00Z");
    expect(rows.find((r) => r.key === "dr:z")?.created).toBe("2026-10-02T00:00:00Z");
    expect(rows.find((r) => r.key === "f:beta")?.created).toBeUndefined();
    expect(rows.find((r) => r.key === "g:p")?.created).toBeUndefined();
  });
});

describe("empty rows and unused takes", () => {
  it("dim a group or folder with nothing in it, and only those", () => {
    const empty = (id: string): FolderNode => ({ id, name: id, linked: false, items: 0, totalItems: 0, bytes: 0, children: [] });
    const t: ProjectsTree = {
      totalBytes: 0,
      groups: [
        group(null),
        group("p", { folders: [empty("bare"), { ...empty("holder"), children: [empty("inner")] }, empty("filed")], timelines: [{ id: "tl", name: "Harbor walk", folderId: "filed", clips: 0, durationMs: 0, bytes: 0, exported: false, unusedTakes: 0, unusedBytes: 0, createdAt: "", updatedAt: "" }], counts: { drafts: 0, timelines: 1, items: 0 } }),
      ],
    };
    const rows = flatten(t, { isOpen: () => true, items: () => ({ items: [], more: false }), drafts: () => undefined });
    const dim = (key: string) => Boolean(rows.find((r) => r.key === key)?.dim);
    expect(rows.find((r) => r.key === "g:inbox")?.meta).toBe("0 timelines · 0 drafts · 0 items");
    expect(dim("g:inbox")).toBe(true);
    expect(dim("g:p")).toBe(false);
    expect(dim("f:bare")).toBe(true);
    expect(dim("f:inner")).toBe(true);
    expect(dim("f:holder")).toBe(false);
    expect(dim("f:filed")).toBe(false);
  });
  it("say a timeline's unused takes and their size in its meta", () => {
    const t: ProjectsTree = { totalBytes: 0, groups: [group("p", { timelines: [{ id: "tl", name: "Harbor walk", folderId: null, clips: 4, durationMs: 20_000, bytes: 1, exported: true, unusedTakes: 31, unusedBytes: 120 * 2 ** 20, createdAt: "", updatedAt: "" }] })] };
    const row = flatten(t, { isOpen: () => true, drafts: () => undefined }).find((r) => r.key === "t:tl");
    expect(row?.meta).toBe("4 clips · 0:20 · exported · 31 unused · 120 MB");
    expect(row?.unused).toEqual({ takes: 31, bytes: 120 * 2 ** 20 });
    expect(flatten(tree, { isOpen: () => true, items: () => ({ items: [], more: false }), drafts: () => undefined }).find((r) => r.key === "t:box")?.unused).toBeUndefined();
  });
});

describe("a folder of the disk", () => {
  it("shows the end of its path, or that it is not found", () => {
    expect(pathEnd("D:\\images\\renders\\refs")).toBe("…\\renders\\refs");
    expect(pathEnd("/srv/media/shoots/day")).toBe("…/shoots/day");
    expect(pathEnd("D:\\refs")).toBe("D:\\refs");
    expect(folderMeta({ items: 2, totalItems: 2, linked: true, path: "D:\\images\\refs" })).toBe("…\\images\\refs · 2 items");
    expect(folderMeta({ items: 2, totalItems: 2, linked: true, path: "D:\\images\\refs", missing: true })).toBe("not found · …\\images\\refs");
  });

  it("says why a drop is refused when the disk is the reason, and nothing otherwise", () => {
    const disk: Target = { kind: "folder", id: "d", group: null, linked: true, ancestors: [], name: "d" };
    const plain: Target = { kind: "folder", id: "f", group: null, linked: false, ancestors: [], name: "f" };
    const timeline: Moving = { kind: "timeline", id: "t", group: null, folder: null, name: "t" };
    expect(whyRefused([timeline], disk)).toBe("a folder of your disk: only files go in it");
    expect(whyRefused([{ kind: "asset", id: "a", folder: "d", name: "a", onDisk: true }], plain)).toBe("a file of your disk: only into another folder of your disk");
    expect(whyRefused([{ kind: "folder", id: "d2", group: null, parent: null, name: "d2", linkedRoot: true }], plain)).toBe("a folder of your disk: drop it on a project");
    // allowed, or refused for another reason: no words
    expect(whyRefused([timeline], plain)).toBeNull();
    expect(whyRefused([{ kind: "folder", id: "f", group: null, parent: null, name: "f" }], plain)).toBeNull();
  });
});
