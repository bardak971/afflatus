import { describe, expect, it } from "vitest";
import { matchQuery, QueryClient, type QueryKey } from "@tanstack/react-query";
import type { Clip } from "../src/api";
import { isAssets, isUnder, LIBRARY_KEYS, queryKeys as k, RENDER_KEYS } from "../src/queryKeys";

/**
 * Each key as the factory makes it, against the array it was written as in the screens before there was a factory:
 * a key that changed here would change what a change reads again, which no type check would see.
 */
const filter = { folder: "A", q: "cat" };
const clip = (id: string, take: string | null, still: string | null = null) =>
  ({ id, takes: take ? [{ id: take, startMs: 0, endMs: 2000 }] : [], take: take ? { id: take, startMs: 0, endMs: 2000 } : null, still: still ? { id: still } : null, atMs: 0, lengthMs: 2000, volume: 1, sound: true, music: null }) as unknown as Clip;
const music = { asset: { id: "m1" }, duck: true, duckDb: 6, startClip: "c1" } as never;

const pinned: Array<[QueryKey, unknown[]]> = [
  [k.recipes(), ["recipes"]],
  [k.setup(), ["setup"]],
  [k.queue(), ["queue"]],
  [k.settings(), ["settings"]],
  [k.health(), ["health"]],
  [k.updates(), ["updates"]],
  [k.entities(), ["entities"]],
  [k.workflows(), ["workflows"]],
  [k.workflowEdit("w1"), ["workflow-edit", "w1"]],
  [k.folders(), ["folders"]],
  [k.storage(), ["storage"]],
  [k.downloads(), ["downloads"]],
  [k.presetFiles(), ["preset-files"]],
  [k.backupPlan(), ["backup-plan"]],
  [k.comfyLog(), ["comfy-log"]],
  [k.nodePack("D:/comfy"), ["node-pack", "D:/comfy"]],
  [k.packs.all(), ["packs"]],
  [k.packs.status(["a", "b"]), ["packs", ["a", "b"]]],
  [k.history.all(), ["history"]],
  [k.history.list({ status: "done" }), ["history", { status: "done" }]],
  [k.timelines.all(), ["timelines"]],
  [k.timelines.lists(), ["timelines", "list"]],
  [k.timelines.list("p1"), ["timelines", "list", "p1"]],
  [k.timelines.one("t1"), ["timelines", "t1"]],
  [k.drafts.all(), ["drafts"]],
  [k.drafts.lists(), ["drafts", "list"]],
  [k.drafts.list("p1"), ["drafts", "list", "p1"]],
  [k.drafts.tree("none"), ["drafts", "list", "tree", "none"]],
  [k.drafts.one("d1"), ["drafts", "d1"]],
  [k.projects.all(), ["projects"]],
  [k.projects.trees(), ["projects", "tree"]],
  [k.projects.tree("", null), ["projects", "tree", "", null]],
  [k.assets.all(), ["assets"]],
  [k.assets.lists(), ["assets", "list"]],
  [k.assets.list("p1", filter, true), ["assets", "list", "p1", filter, true]],
  [k.assets.tree("A", null, 1, "name", false), ["assets", "tree", "A", null, 1, "name", false]],
  [k.assets.one("i1"), ["assets", "one", "i1"]],
  [k.assets.unkept("p1"), ["assets", "unkept", "all", "p1"]],
  [k.facets.all(), ["facets"]],
  [k.facets.families(), ["facets", "families"]],
  [k.facets.models(), ["facets", "models"]],
  [k.renders.all(), ["renders"]],
  [k.renders.summary("week"), ["renders", "summary", "week"]],
  [k.renders.list("flux", "trouble", "all"), ["renders", "list", "flux", "trouble", "all"]],
  [k.renders.lanes("all"), ["renders", "lanes", "all"]],
  [k.renders.size(), ["renders", "size"]],
  [k.modelUpdates(), ["model-updates"]],
  [k.modelSettings(), ["model-settings"]],
  [k.modelInfo.all(), ["model-info"]],
  [k.modelInfo.of("loras"), ["model-info", "loras"]],
  [k.modelPages("loras"), ["model-pages", "loras"]],
  [k.modelWords("loras"), ["model-words", "loras"]],
  [k.motion("a1"), ["motion", "a1"]],
  [k.scenes("a1"), ["scenes", "a1"]],
  [k.advice.all(), ["advice"]],
  [k.advice.form("r1", "{}", null), ["advice", "r1", "{}", null]],
  [k.compose.all(), ["compose"]],
  [k.compose.form("r1", { a: 1 }, "now"), ["compose", "r1", { a: 1 }, "now"]],
  [k.compose.pictures("r1", ["p"], []), ["compose", "pictures", "r1", ["p"], []]],
  [k.designerSystem("x"), ["designer-system", "x"]],
  [k.designerKnows("r1", "[]"), ["designer-knows", "r1", "[]"]],
  [k.designerGuides(), ["designer-guides"]],
  [k.loaded("q", "j"), ["loaded", "q", "j"]],
  [k.commandIndex.all(), ["command-index"]],
  [k.commandIndex.items("cat"), ["command-index", "items", "cat"]],
  [k.barEstimate({ timeline: "t1" }), ["bar-estimate", { timeline: "t1" }]],
  [k.promptHistory.all(), ["prompt-history"]],
  [k.promptHistory.search("cat"), ["prompt-history", "cat"]],
  [k.timelineEstimate("t1", 3, "2026"), ["timeline-estimate", "t1", 3, "2026"]],
  [k.finishForecast.all(), ["finishForecast"]],
  [k.finishForecast.of("t1", { h3: true }, false, "a,b"), ["finishForecast", "t1", { h3: true }, false, "a,b"]],
  [k.forecasts([1]), ["forecasts", [1]]],
  [k.joins.around(clip("c2", "k2"), clip("c1", null, "s1"), undefined), ["joins", "c2", "k2:0:2000", "s1", "-"]],
  [k.joins.ofTake("c2", "k2", 0, 2000), ["joins", "c2", "k2", 0, 2000]],
  [k.match("t1", [clip("c1", "k1"), clip("c2", null, "s2"), clip("c3", null)]), ["match", "t1", "k1:0:2000,s2:0:0,-:0:0"]],
  [k.duck("t1", music, [clip("c1", "k1")]), ["duck", "t1", "m1", true, 6, "c1", "c1:k1:0:2000:1:true:"]],
];

describe("query keys", () => {
  it("are the arrays the screens used", () => {
    for (const [made, was] of pinned) expect(made).toEqual(was);
  });

  it("keep what sits under what: a prefix still finds the same queries", () => {
    const client = new QueryClient();
    for (const [key] of pinned) client.setQueryData(key, 1);
    const under = (prefix: QueryKey) => client.getQueryCache().findAll({ queryKey: prefix }).map((q) => q.queryKey);
    const fromLiterals = (prefix: unknown[]) => pinned.filter(([, was]) => matchQuery({ queryKey: prefix }, { queryKey: was } as never)).map(([, was]) => was);
    for (const prefix of [k.assets.all(), k.assets.lists(), k.timelines.all(), k.timelines.lists(), k.drafts.all(), k.drafts.lists(), k.projects.all(), k.renders.all(), k.history.all(), k.commandIndex.all(), k.compose.all(), k.queue()]) {
      expect(under(prefix)).toEqual(expect.arrayContaining(fromLiterals([...prefix])));
      expect(under(prefix)).toHaveLength(fromLiterals([...prefix]).length);
    }
    // the drafts of the Projects panel are under the lists, an item's details under the library
    expect(isUnder(k.drafts.tree("g"), k.drafts.lists())).toBe(true);
    expect(isUnder(k.assets.one("i"), k.assets.all())).toBe(true);
    expect(isUnder(k.history.all(), k.queue())).toBe(false);
  });

  it("say which part of the library a key is", () => {
    expect(isAssets(k.assets.list("p", {}, false), "list")).toBe(true);
    expect(isAssets(k.assets.tree("A", null, 1, "new", true), "tree")).toBe(true);
    expect(isAssets(k.assets.one("i"), "one")).toBe(true);
    expect(isAssets(k.assets.unkept("p"), "unkept")).toBe(true);
    expect(isAssets(k.folders(), "list")).toBe(false);
  });

  it("list what a library event and a render's end read again as before", () => {
    expect(LIBRARY_KEYS).toEqual([["assets"], ["folders"], ["storage"], ["projects"], ["facets"]]);
    expect(RENDER_KEYS).toEqual([["renders"], ["advice"], ["finishForecast"]]);
  });
});
