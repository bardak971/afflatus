import { describe, expect, it } from "vitest";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import type { Asset, Folder } from "../src/api";
import { applyChange, changed, findAsset, fits, mergeTop, placeName, placesBefore, readsTop, rollback, type Seats } from "../src/assetCache";
import { refusedTitle } from "../src/assetChange";

const NOW = "2026-10-10T12:00:00.000Z";

const item = (id: string, more: Partial<Asset> = {}): Asset => ({
  id, kind: "image", origin: "generated", name: "", mime: "image/png", bytes: 1, width: 1, height: 1, durationMs: null, fps: null,
  hasSound: false, kept: false, inBin: false, folderId: "f1", generationId: null, createdAt: "2026-10-09T12:00:00.000Z", path: null, ...more,
});
type Page = { items: Asset[]; next: string | null; prev: string | null };
const pages = (...lists: Asset[][]): InfiniteData<Page> => ({ pages: lists.map((items) => ({ items, next: null, prev: null })), pageParams: lists.map(() => ({})) });
const folder = (id: string, projectId: string | null, count: number): Folder => ({ id, parentId: null, name: id.toUpperCase(), count, projectId, path: null, root: false });

/** A client holding what the screens read: folder f1's list, the project's whole list, the bin, Kept only, the Projects panel's f1, the item, the expiring count, the folders. */
function screen() {
  const client = new QueryClient();
  const a = item("a");
  const b = item("b", { kept: true });
  const c = item("c", { folderId: "f2" });
  client.setQueryData(["assets", "list", "p1", { folder: "f1" }, true], pages([a], [b]));
  client.setQueryData(["assets", "list", "p1", {}, true], pages([a, b, c]));
  client.setQueryData(["assets", "list", "p1", { bin: true }, true], pages([]));
  client.setQueryData(["assets", "list", "p1", { kept: true }, true], pages([b]));
  client.setQueryData(["assets", "tree", "f1", null, 1, "new", true], { items: [a, b], more: false });
  client.setQueryData(["assets", "one", "a"], { ...a, generation: null });
  client.setQueryData(["assets", "unkept", "all", "p1"], { count: 2, from: "2026-10-09T12:00:00.000Z", to: "2026-10-09T13:00:00.000Z" });
  client.setQueryData(["folders"], { items: [folder("f1", "p1", 2), folder("f2", "p1", 1), folder("g1", "p2", 0)] });
  return client;
}
const ids = (client: QueryClient, key: unknown[]) => client.getQueryData<InfiniteData<Page>>(key)!.pages.flatMap((p) => p.items.map((x) => x.id));
const counts = (client: QueryClient) => Object.fromEntries(client.getQueryData<{ items: Folder[] }>(["folders"])!.items.map((f) => [f.id, f.count]));
const tree = (client: QueryClient) => client.getQueryData<{ items: Asset[] }>(["assets", "tree", "f1", null, 1, "new", true])!.items;

describe("an item changed on screen before the server answers", () => {
  it("flips Kept on every copy at once, and the expiring count with it", () => {
    const client = screen();
    applyChange(client, { kind: "keep", ids: ["a"], kept: true }, NOW);
    expect(client.getQueryData<Asset>(["assets", "one", "a"])!.kept).toBe(true);
    expect(client.getQueryData<InfiniteData<Page>>(["assets", "list", "p1", {}, true])!.pages[0]!.items[0]!.kept).toBe(true);
    expect(tree(client)[0]!.kept).toBe(true);
    expect(client.getQueryData<{ count: number }>(["assets", "unkept", "all", "p1"])!.count).toBe(1);
  });

  it("takes an unkept item out of Kept only, and starts its day again", () => {
    const client = screen();
    applyChange(client, { kind: "keep", ids: ["b"], kept: false }, NOW);
    expect(ids(client, ["assets", "list", "p1", { kept: true }, true])).toEqual([]);
    expect(findAsset(client, "b")).toMatchObject({ kept: false, countdownFrom: NOW });
    expect(client.getQueryData(["assets", "unkept", "all", "p1"])).toEqual({ count: 3, from: "2026-10-09T12:00:00.000Z", to: NOW });
  });

  it("moves an item out of its folder's lists at once, keeps it in the project's list, and counts the folders over", () => {
    const client = screen();
    applyChange(client, { kind: "move", ids: ["a"], folder: "f2" }, NOW);
    expect(ids(client, ["assets", "list", "p1", { folder: "f1" }, true])).toEqual(["b"]);
    expect(ids(client, ["assets", "list", "p1", {}, true])).toEqual(["a", "b", "c"]);
    expect(findAsset(client, "a")!.folderId).toBe("f2");
    expect(tree(client).map((x) => x.id)).toEqual(["b"]);
    expect(counts(client)).toEqual({ f1: 1, f2: 2, g1: 0 });
  });

  it("takes an item moved to another project out of the project's lists too", () => {
    const client = screen();
    applyChange(client, { kind: "move", ids: ["a"], folder: "g1" }, NOW);
    expect(ids(client, ["assets", "list", "p1", {}, true])).toEqual(["b", "c"]);
  });

  it("bins items out of every list but the bin's, which is read again rather than guessed", () => {
    const client = screen();
    applyChange(client, { kind: "bin", ids: ["a", "b"] }, NOW);
    expect(ids(client, ["assets", "list", "p1", {}, true])).toEqual(["c"]);
    expect(ids(client, ["assets", "list", "p1", { bin: true }, true])).toEqual([]);
    expect(client.getQueryData<Asset>(["assets", "one", "a"])!.inBin).toBe(true);
    expect(client.getQueryData<{ count: number }>(["assets", "unkept", "all", "p1"])!.count).toBe(1);
    expect(counts(client)).toEqual({ f1: 0, f2: 1, g1: 0 });
  });

  it("shows a new name at once, the name worked out from its origin no longer shown", () => {
    const client = screen();
    client.setQueryData(["assets", "one", "a"], { ...item("a", { shownName: "Big Air · c2 · t5" }), generation: null });
    applyChange(client, { kind: "rename", ids: ["a"], name: "zz-test launch" }, NOW);
    expect(client.getQueryData<Asset>(["assets", "one", "a"])).toMatchObject({ name: "zz-test launch", shownName: undefined });
    expect(ids(client, ["assets", "list", "p1", {}, true])).toEqual(["a", "b", "c"]);
    expect(client.getQueryData<InfiniteData<Page>>(["assets", "list", "p1", {}, true])!.pages[0]!.items[0]!.name).toBe("zz-test launch");
  });

  it("puts every copy back as it was when the server refuses", () => {
    const client = screen();
    const before = client.getQueryCache().getAll().map((q) => [q.queryKey, q.state.data]);
    const snap = applyChange(client, { kind: "move", ids: ["a", "b"], folder: "g1" }, NOW);
    expect(snap.length).toBeGreaterThan(0);
    rollback(client, snap);
    expect(client.getQueryCache().getAll().map((q) => [q.queryKey, q.state.data])).toEqual(before);
  });

  it("puts binned items back where they sat on an Undo, not at the end", () => {
    const client = screen();
    const key = ["assets", "list", "p1", {}, true];
    const left: Seats = [];
    applyChange(client, { kind: "bin", ids: ["b"] }, NOW, { left });
    expect(ids(client, key)).toEqual(["a", "c"]);
    applyChange(client, { kind: "restore", ids: ["b"] }, NOW, { back: left });
    expect(ids(client, key)).toEqual(["a", "b", "c"]);
    // twice does not make two
    applyChange(client, { kind: "restore", ids: ["b"] }, NOW, { back: left });
    expect(ids(client, key)).toEqual(["a", "b", "c"]);
  });

  it("on a refusal, undoes only what the refused change did: a later change that went through stays on screen", () => {
    const client = screen();
    const key = ["assets", "list", "p1", {}, true];
    // a bin the server will refuse, then a keep that goes through while it is out
    const snap = applyChange(client, { kind: "bin", ids: ["a"] }, NOW);
    applyChange(client, { kind: "keep", ids: ["c"], kept: true }, NOW);
    rollback(client, snap);
    expect(ids(client, key)).toEqual(["a", "b", "c"]);
    expect(findAsset(client, "a")!.inBin).toBe(false);
    expect(client.getQueryData<InfiniteData<Page>>(key)!.pages[0]!.items.find((x) => x.id === "c")!.kept).toBe(true);
  });

  it("puts each folder's items back in their own folder on the Undo of a move from several folders", () => {
    const client = new QueryClient();
    const a = item("a", { folderId: "f1" });
    const c = item("c", { folderId: "f2" });
    client.setQueryData(["assets", "list", "p1", { folder: "f1" }, true], pages([a]));
    client.setQueryData(["assets", "list", "p1", { folder: "f2" }, true], pages([c]));
    client.setQueryData(["assets", "list", "p1", {}, true], pages([a, c]));
    client.setQueryData(["folders"], { items: [folder("f1", "p1", 1), folder("f2", "p1", 1), folder("g1", "p2", 0)] });
    const left: Seats = [];
    applyChange(client, { kind: "move", ids: ["a", "c"], folder: "g1" }, NOW, { left });
    // to a folder of another project: out of this project's list too
    expect(ids(client, ["assets", "list", "p1", {}, true])).toEqual([]);
    // the Undo: one change a folder, each handed every seat
    applyChange(client, { kind: "move", ids: ["a"], folder: "f1" }, NOW, { back: left });
    // the first folder's change puts back its own items only (c's change is sent after a's is answered)
    expect(findAsset(client, "c")).toBeUndefined();
    applyChange(client, { kind: "move", ids: ["c"], folder: "f2" }, NOW, { back: left });
    expect(ids(client, ["assets", "list", "p1", { folder: "f1" }, true])).toEqual(["a"]);
    expect(ids(client, ["assets", "list", "p1", { folder: "f2" }, true])).toEqual(["c"]);
    // in the project's list, each back once, in its own folder
    const all = client.getQueryData<InfiniteData<Page>>(["assets", "list", "p1", {}, true])!.pages.flatMap((p) => p.items);
    expect(all.map((x) => `${x.id}:${x.folderId}`)).toEqual(["a:f1", "c:f2"]);
  });

  it("keeps no copy of what does not hold the items", () => {
    const client = screen();
    const snap = applyChange(client, { kind: "keep", ids: ["c"], kept: true }, NOW);
    expect(snap.map(([k]) => k)).not.toContainEqual(["assets", "list", "p1", { folder: "f1" }, true]);
  });
});

describe("whether an item belongs in a list", () => {
  const projectOf = (f: string): string | null | undefined => ({ f1: "p1", g1: "p2" } as Record<string, string>)[f];
  it("goes by the bin, the folder, kept or not, and the project when nothing else says where", () => {
    expect(fits({}, "p1", item("a"), projectOf)).toBe(true);
    expect(fits({}, "p1", item("a", { inBin: true }), projectOf)).toBe(false);
    expect(fits({ bin: true }, "p1", item("a", { inBin: true }), projectOf)).toBe(true);
    expect(fits({ folder: "none" }, "p1", item("a", { folderId: null }), projectOf)).toBe(true);
    expect(fits({ folder: "f1" }, "p1", item("a", { folderId: "g1" }), projectOf)).toBe(false);
    expect(fits({ unkept: true }, "p1", item("a", { kept: true }), projectOf)).toBe(false);
    expect(fits({}, "p1", item("a", { folderId: "g1" }), projectOf)).toBe(false);
    expect(fits({}, "none", item("a", { folderId: null }), projectOf)).toBe(true);
    // a draft's list is not scoped to the project
    expect(fits({ draft: "d1" }, "p1", item("a", { folderId: "g1" }), projectOf)).toBe(true);
    // a folder nobody knows of: not taken out for it
    expect(fits({}, "p1", item("a", { folderId: "zz" }), projectOf)).toBe(true);
  });
});

describe("Undo and the words said", () => {
  it("remembers where each item was, folder by folder, for the move back", () => {
    expect(placesBefore(screen(), ["a", "c", "unknown"])).toEqual([{ folder: "f1", ids: ["a"] }, { folder: "f2", ids: ["c"] }]);
  });

  it("names the place: a project's root folder by the project, a folder by its name, the Inbox", () => {
    const folders = [folder("f1", "p1", 0), folder("root", "p1", 0)];
    const projects = [{ id: "p1", name: "Big Air", folderId: "root" }];
    expect(placeName("root", folders, projects)).toBe("Big Air");
    expect(placeName("f1", folders, projects)).toBe("F1");
    expect(placeName(null, folders, projects)).toBe("the Inbox");
  });

  it("says what was refused, to one item or several; a put back starts the day again", () => {
    expect(refusedTitle({ kind: "keep", ids: ["a"], kept: true })).toBe("Could not keep it");
    expect(refusedTitle({ kind: "bin", ids: ["a", "b"] })).toBe("Could not move them to the bin");
    expect(changed(item("a", { inBin: true }), { kind: "restore", ids: ["a"] }, NOW)).toMatchObject({ inBin: false, countdownFrom: NOW });
  });
});

describe("items added, read into a list by its first page", () => {
  const top = (...list: Asset[]): Page => ({ items: list, next: "cursor", prev: null });
  const [n1, n2, a, b, c, d] = ["n1", "n2", "a", "b", "c", "d"].map((id) => item(id)) as [Asset, Asset, Asset, Asset, Asset, Asset];

  it("puts the new items above the first page, the pages below left as they are", () => {
    const list = pages([a, b], [c, d]);
    const merged = mergeTop(list, top(n1, n2, a, b))!;
    expect(merged.pages.map((p) => p.items.map((x) => x.id))).toEqual([["n1", "n2", "a", "b"], ["c", "d"]]);
    // the second page is the same object: nothing of it is read or drawn again
    expect(merged.pages[1]).toBe(list.pages[1]);
    // nothing new: the list as it was
    expect(mergeTop(list, top(a, b))).toBe(list);
  });

  it("gives up (the list is read whole) when the first page cannot say where the new items go", () => {
    // more new items than a page: what was at the top is not in it
    expect(mergeTop(pages([a, b], [c, d]), top(n1, n2))).toBeNull();
    // a new item below one already there: made earlier than the top of the list
    expect(mergeTop(pages([a, b], [c, d]), top(a, n1, b))).toBeNull();
    // a capped list scrolled down: its first page is not the top of the list
    expect(mergeTop({ pages: [{ items: [c], next: null, prev: "x" }, { items: [d], next: null, prev: null }], pageParams: [{}, {}] }, top(n1, a, b, c))).toBeNull();
  });

  it("is only for a list newest first, not searched, with more than one page loaded", () => {
    const two = pages([a], [b]);
    expect(readsTop(["assets", "list", "p1", {}, false], two)).toBe(true);
    expect(readsTop(["assets", "list", "p1", { folder: "f1", kind: "image" }, true], two)).toBe(true);
    expect(readsTop(["assets", "list", "p1", {}, false], pages([a]))).toBe(false);
    expect(readsTop(["assets", "list", "p1", { q: "cat" }, false], two)).toBe(false);
    expect(readsTop(["assets", "list", "p1", { model: "m.safetensors" }, false], two)).toBe(false);
    expect(readsTop(["assets", "tree", "f1", null, 1, "new", true], two)).toBe(false);
  });
});
