import { describe, expect, it } from "vitest";
import { LIBRARY_KEYS, libraryKeysOf, unionKeys } from "../src/data";

describe("a library event on the page", () => {
  it("reads again only the lists the change can touch", () => {
    expect(libraryKeysOf({ items: ["a"], change: "fields" })).toEqual([["assets"]]);
    expect(libraryKeysOf({ change: "kept" })).toEqual([["assets"], ["storage"]]);
    expect(libraryKeysOf({ change: "places" })).toEqual([["folders"], ["projects"]]);
    // nothing said, or an event from an older server: everything
    expect(libraryKeysOf({})).toBe(LIBRARY_KEYS);
    expect(libraryKeysOf(null)).toBe(LIBRARY_KEYS);
  });

  it("gathers the lists of several events read in one go, each once", () => {
    const keys = unionKeys(unionKeys([], libraryKeysOf({ change: "fields" })), libraryKeysOf({ change: "kept" }));
    expect(keys).toEqual([["assets"], ["storage"]]);
    expect(unionKeys(keys, LIBRARY_KEYS)).toHaveLength(LIBRARY_KEYS.length);
  });
});
