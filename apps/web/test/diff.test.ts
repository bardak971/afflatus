import { describe, expect, it } from "vitest";
import { changedShare, wordDiff } from "../src/diff";

const text = (pieces: NonNullable<ReturnType<typeof wordDiff>>) => pieces.map((p) => `${p.kind === "added" ? "+" : p.kind === "removed" ? "-" : ""}${p.text}`).join("|");

describe("the word diff", () => {
  it("marks a word added and a word taken out, and keeps the rest", () => {
    const d = wordDiff("a red dress at dusk", "a blue dress at night")!;
    expect(text(d)).toBe("a |-red|+blue| dress at |-dusk|+night");
  });
  it("is empty of changes when only the white space changed", () => {
    const d = wordDiff("a red\ndress", "a red dress")!;
    expect(d.every((p) => p.kind === "same")).toBe(true);
    expect(d.map((p) => p.text).join("")).toBe("a red dress");
  });
  it("gives the new text back when read in order, the struck words aside", () => {
    const d = wordDiff("one two three", "one three four")!;
    expect(d.filter((p) => p.kind !== "removed").map((p) => p.text).join("")).toBe("one three four");
  });
  it("gives up on texts too long to compare", () => {
    const long = Array.from({ length: 1500 }, (_, i) => `w${i}`).join(" ");
    expect(wordDiff(long, "short")).toBeNull();
  });
});

describe("how much of a text is new", () => {
  it("is nothing when nothing was added, everything when all of it is new", () => {
    expect(changedShare([{ text: "same", kind: "same" }])).toBe(0);
    expect(changedShare([{ text: "new", kind: "added" }])).toBe(1);
  });
  it("counts the struck words out: they are not part of the new text", () => {
    expect(changedShare([{ text: "ab", kind: "same" }, { text: "cd", kind: "added" }, { text: "zzzz", kind: "removed" }])).toBe(0.5);
  });
  it("is nothing for nothing", () => {
    expect(changedShare([])).toBe(0);
  });
});

describe("the word diff at the edges", () => {
  it("marks everything added from an empty text, and everything gone to one", () => {
    expect(text(wordDiff("", "two words")!)).toBe("+two words");
    expect(text(wordDiff("two words", "")!)).toBe("-two words");
    expect(wordDiff("", "")).toEqual([]);
  });
  it("tells a word with its punctuation from the word without it", () => {
    expect(text(wordDiff("a dress, red", "a dress red")!)).toBe("a |-dress,|+dress| red");
  });
  it("is all the same for the same text", () => {
    expect(wordDiff("same words here", "same words here")).toEqual([{ text: "same words here", kind: "same" }]);
  });
});
