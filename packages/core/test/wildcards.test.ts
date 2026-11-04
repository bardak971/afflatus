import { describe, expect, it } from "vitest";
import { expandWildcards, hasWildcards, MissingWildcard, seededRandom, type WildcardFiles } from "../src/wildcards";

describe("choices written in a prompt", () => {
  it("picks one of the choices", () => {
    expect(expandWildcards("a {red|black|white} dress", () => 0)).toBe("a red dress");
    expect(expandWildcards("a {red|black|white} dress", () => 0.5)).toBe("a black dress");
    expect(expandWildcards("a {red|black|white} dress", () => 0.999)).toBe("a white dress");
  });

  it("settles a choice inside a choice, and several in one text", () => {
    expect(expandWildcards("{a|{b|c}} and {x|y}", () => 0.999)).toBe("c and y");
    expect(expandWildcards("{a|{b|c}} and {x|y}", () => 0)).toBe("a and x");
  });

  it("can pick nothing", () => {
    expect(expandWildcards("1girl{|, smiling}", () => 0)).toBe("1girl");
    expect(expandWildcards("1girl{|, smiling}", () => 0.9)).toBe("1girl, smiling");
  });

  it("leaves braces without a bar, and text without braces, as they are", () => {
    expect(expandWildcards('{"scene": "a street"} and <d>[English] a|b</d>')).toBe('{"scene": "a street"} and <d>[English] a|b</d>');
    expect(hasWildcards("a {red} dress")).toBe(false);
    expect(hasWildcards("a {red|blue} dress")).toBe(true);
  });

  it("varies from one call to the next", () => {
    const seen = new Set(Array.from({ length: 60 }, () => expandWildcards("{1|2|3|4}")));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("reads a long run of bars in linear time", () => {
    // an open brace and 100 000 bars with no closing brace: the old pattern went back over every bar from every bar (seconds)
    const long = `{${"a|".repeat(50_000)}`;
    const start = performance.now();
    expect(hasWildcards(long)).toBe(false);
    expect(expandWildcards(long)).toBe(long);
    expect(hasWildcards(`${long}}`)).toBe(true);
    expect(performance.now() - start).toBeLessThan(100);
  });

  it("reads a wildcard file, nested names and choices in its lines", () => {
    const lines: Record<string, string[]> = { colors: ["red", "{deep|pale} blue"], "clothes/hats": ["a __colors__ beret"] };
    const files: WildcardFiles = (name) => lines[name];
    expect(expandWildcards("__colors__ dress", () => 0, files)).toBe("red dress");
    expect(expandWildcards("__colors__ dress", () => 0.99, files)).toBe("pale blue dress");
    expect(expandWildcards("__clothes/hats__", () => 0.99, files)).toBe("a pale blue beret");
    // {__colors__|plain}: the choice first, then the file it picked
    expect(expandWildcards("{__colors__|plain} wall", () => 0, files)).toBe("red wall");
    expect(hasWildcards("a __colors__ dress")).toBe(true);
    // a run of underscores in a tag is no name, and without the files a name is left as written
    expect(hasWildcards("^___^, smile")).toBe(false);
    expect(expandWildcards("__colors__ dress", () => 0)).toBe("__colors__ dress");
  });

  it("refuses a name with no file, and files that name each other", () => {
    expect(() => expandWildcards("__nope__", () => 0, () => undefined)).toThrow(MissingWildcard);
    expect(() => expandWildcards("__loop__", () => 0, () => ["__loop__"])).toThrow(/circle/);
    // an empty file puts nothing in
    expect(expandWildcards("a__empty__b", () => 0, () => [])).toBe("ab");
  });

  it("picks the same for the same seed, and apart for another seed or text", () => {
    const files: WildcardFiles = () => Array.from({ length: 50 }, (_, i) => `c${i}`);
    const text = "__a__, __b__, {x|y|z}";
    const once = expandWildcards(text, seededRandom(1234, "prompt"), files);
    expect(expandWildcards(text, seededRandom(1234, "prompt"), files)).toBe(once);
    const others = new Set(Array.from({ length: 20 }, (_, i) => expandWildcards(text, seededRandom(i, "prompt"), files)));
    expect(others.size).toBeGreaterThan(15);
    expect(expandWildcards(text, seededRandom(1234, "negative"), files)).not.toBe(once);
  });
});
