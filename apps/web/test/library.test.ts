import { describe, expect, it, vi } from "vitest";
import type { Entity, Folder } from "../src/api";
import { menuAt } from "../src/ContextMenu";
import { downloadName } from "../src/download";
import { fileKind, kindOfType, zonesFor } from "../src/dropZones";
import { folderMaker, pathOf } from "../src/folderImport";
import { presetOfFile, presetToFile, slug } from "../src/presetFile";
import { foldersOf, tree } from "../src/screens/library/tree";

const folder = (id: string, parentId: string | null, projectId: string | null = null): Folder => ({ id, parentId, name: id, count: 0, path: null, root: false, projectId }) as Folder;

describe("the folder tree", () => {
  it("lists folders in reading order with their depth", () => {
    const t = tree([folder("b", "a"), folder("a", null), folder("c", null), folder("d", "b")]);
    expect(t.map((f) => `${f.id}${f.depth}`)).toEqual(["a0", "b1", "d2", "c0"]);
  });
  it("keeps a folder whose parent is gone reachable, at the top", () => {
    expect(tree([folder("x", "gone")]).map((f) => [f.id, f.depth])).toEqual([["x", 0]]);
  });
  it("shows a loop of parents once, not for ever", () => {
    const t = tree([folder("p", "q"), folder("q", "p")]);
    expect(t.map((f) => f.id).sort()).toEqual(["p", "q"]);
  });
  it("keeps the folders of the project looked at", () => {
    const all = [folder("a", null, "p1"), folder("b", null, null)];
    expect(foldersOf(all, null)).toHaveLength(2);
    expect(foldersOf(all, "none").map((f) => f.id)).toEqual(["b"]);
    expect(foldersOf(all, "p1").map((f) => f.id)).toEqual(["a"]);
  });
});

describe("a folder brought in from the computer", () => {
  it("reads the folders a file sits in", () => {
    expect(pathOf({ webkitRelativePath: "shoot/day 1/a.png", name: "a.png" })).toEqual(["shoot", "day 1"]);
    expect(pathOf({ name: "a.png" })).toEqual([]);
  });
  it("makes each folder once, and uses one already there", async () => {
    const make = vi.fn(async (name: string, parent: string | null) => `${parent ?? "top"}/${name}`);
    const folderFor = folderMaker("into", [{ id: "old", parentId: "into", name: "shoot" }], make);
    const [a, b, c] = await Promise.all([folderFor(["shoot", "day 1"]), folderFor(["shoot", "day 1"]), folderFor([])]);
    expect(a).toBe("old/day 1");
    expect(b).toBe(a);
    expect(c).toBe("into");
    expect(make).toHaveBeenCalledTimes(1);
  });
});

describe("what a file dragged in can do", () => {
  it("tells a file by its type, else by its name", () => {
    expect(kindOfType("image/png", true)).toBe("image");
    expect(kindOfType("application/json", true)).toBe("json");
    expect(kindOfType(undefined, true)).toBe("other");
    expect(kindOfType(undefined, false)).toBeNull();
    expect(fileKind({ type: "", name: "clip.MOV" })).toBe("video");
    expect(fileKind({ type: "", name: "voice.m4a" })).toBe("audio");
    expect(fileKind({ type: "", name: "flow.json" })).toBe("json");
  });
  it("offers what fits the kind, and the timeline only on a timeline", () => {
    expect(zonesFor("image", false).map((z) => z.id)).toEqual(["library", "settings", "workflow"]);
    expect(zonesFor("audio", true).map((z) => z.id)).toEqual(["library", "timeline"]);
    expect(zonesFor("json", true).map((z) => z.id)).toEqual(["workflow"]);
    expect(zonesFor(null, true)).toEqual([]);
  });
});

describe("files saved", () => {
  it("names an item by its own name, else its id and the extension of its type", () => {
    expect(downloadName({ id: "x", name: "mine.png", mime: "image/png" })).toBe("mine.png");
    expect(downloadName({ id: "x", name: "", mime: "video/mp4" })).toBe("x.mp4");
    expect(downloadName({ id: "x", name: "", mime: "model/gltf" })).toBe("x.bin");
  });
  it("writes a preset as the shipped files are, and reads it back", () => {
    const e = { id: "e1", kind: "preset", name: "Soft Light!", source: "user", def: { recipe: "flux", inputs: { steps: 20 }, look: { cast: [], style: null } } } as unknown as Extract<Entity, { kind: "preset" }>;
    const file = presetToFile(e);
    expect(file).toEqual({ id: "soft-light", name: "Soft Light!", recipe: "flux", inputs: { steps: 20 }, files: [] });
    expect(presetOfFile(file, "x.json")).toEqual({ name: "Soft Light!", def: { recipe: "flux", inputs: { steps: 20 }, files: [] } });
    expect(presetOfFile({ inputs: {} }, "from disk.json").name).toBe("from disk");
    expect(presetOfFile({ name: "kept", def: { inputs: { a: 1 } } }, "f.json").def).toEqual({ inputs: { a: 1 } });
    expect(slug("  ")).toBe("preset");
  });
});

describe("where a menu opens", () => {
  const el = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 300 }) };
  it("opens at the pointer", () => {
    expect(menuAt({ clientX: 10, clientY: 20 }, el)).toEqual({ x: 10, y: 20 });
  });
  it("opens on the element when the keyboard opened it, its first item ready", () => {
    expect(menuAt({ clientX: 0, clientY: 0 }, el)).toEqual({ x: 116, y: 78, keyed: true });
    expect(menuAt({ clientX: 0, clientY: 0 }, null)).toEqual({ x: 0, y: 0 });
  });
});
