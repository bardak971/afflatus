import { describe, expect, it } from "vitest";
import { kitHash, kitHref, readKitHash } from "../src/screens/kit/link";

describe("the Prompt kit's address", () => {
  it("names the tab and the item open in it, and reads back what it wrote", () => {
    expect(kitHref("person", "ab12")).toBe("/kit#people/ab12");
    expect(kitHref("preset", "shipped:krea")).toBe("/kit#presets/shipped%3Akrea");
    expect(kitHash("place")).toBe("#places");
    // the snippets are a table: no item is open in it
    expect(kitHash("snippet", "x")).toBe("#snippets");
    expect(readKitHash("#people/ab12")).toEqual({ tab: "person", id: "ab12" });
    expect(readKitHash("#presets/shipped%3Akrea")).toEqual({ tab: "preset", id: "shipped:krea" });
    expect(readKitHash("#Styles")).toEqual({ tab: "style", id: null });
    expect(readKitHash("#snippets/x")).toEqual({ tab: "snippet", id: null });
  });

  it("names no tab for an address of something else", () => {
    expect(readKitHash("")).toBeNull();
    expect(readKitHash("#queue")).toBeNull();
  });
});
