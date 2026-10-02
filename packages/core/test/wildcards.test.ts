import { describe, expect, it } from "vitest";
import { expandWildcards, hasWildcards } from "../src/wildcards";

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
});
