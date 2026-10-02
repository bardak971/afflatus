import { describe, expect, it } from "vitest";
import { appendTo, nudgeWeight, removeFrom, replaceTag, wordsIn } from "../src/promptText";

describe("the weight of a tag", () => {
  const at = (text: string, find: string) => text.indexOf(find) + 1;

  it("goes up and down on the tag the cursor is in", () => {
    const text = "1girl, red dress, smile";
    const up = nudgeWeight(text, at(text, "red"), at(text, "red"), 0.1)!;
    expect(up.text).toBe("1girl, (red dress:1.1), smile");
    expect(up.text.slice(up.start, up.end)).toBe("(red dress:1.1)");
    const again = nudgeWeight(up.text, up.start, up.end, 0.1)!;
    expect(again.text).toBe("1girl, (red dress:1.2), smile");
    const down = nudgeWeight(text, at(text, "smile"), at(text, "smile"), -0.1)!;
    expect(down.text).toBe("1girl, red dress, (smile:0.9)");
  });

  it("takes its brackets off when it is back at 1", () => {
    const text = "1girl, (red dress:1.1), smile";
    const i = at(text, "red");
    expect(nudgeWeight(text, i, i, -0.1)!.text).toBe("1girl, red dress, smile");
  });

  it("works on what is selected, and knows a selection that sits inside a weight", () => {
    const text = "a woman in a red dress on a terrace";
    const s = text.indexOf("red dress");
    expect(nudgeWeight(text, s, s + 9, 0.1)!.text).toBe("a woman in a (red dress:1.1) on a terrace");
    const inside = "a (red dress:1.2) here";
    const i = inside.indexOf("red dress");
    expect(nudgeWeight(inside, i, i + 9, 0.1)!.text).toBe("a (red dress:1.3) here");
  });

  it("does nothing without a selection where the text is sentences, or in an empty place", () => {
    expect(nudgeWeight("a woman on a terrace", 3, 3, 0.1, false)).toBeNull();
    expect(nudgeWeight("1girl, , smile", 7, 7, 0.1)).toBeNull();
  });

  it("stops at a line break as at a comma", () => {
    const text = "1girl\nred dress\nsmile";
    expect(nudgeWeight(text, 8, 8, 0.1)!.text).toBe("1girl\n(red dress:1.1)\nsmile");
  });
});

describe("a tag swapped for another", () => {
  it("keeps its weight and the layout, between commas and inside choices", () => {
    expect(replaceTag("1girl, (grinning:1.2),  long hair", "(grinning:1.2)", "grin")).toBe("1girl, (grin:1.2),  long hair");
    expect(replaceTag("{red dress|grinning}, 1girl", "grinning", "grin")).toBe("{red dress|grin}, 1girl");
    // only the whole tag, not a part of another
    expect(replaceTag("grinning girl, grinning", "grinning", "grin")).toBe("grinning girl, grin");
  });
});

describe("text added to a prompt", () => {
  it("goes after a comma for tags and after a space for sentences, never twice", () => {
    expect(appendTo("1girl, smile", "film grain", "tags")).toBe("1girl, smile, film grain");
    expect(appendTo("1girl, smile, ", "film grain", "tags")).toBe("1girl, smile, film grain");
    expect(appendTo("", "film grain", "tags")).toBe("film grain");
    expect(appendTo("She waves.", "Shot on film.", "sentences")).toBe("She waves. Shot on film.");
    expect(appendTo("1girl, Film Grain", "film grain", "tags")).toBe("1girl, Film Grain");
  });
});

describe("a LoRA's words in a prompt", () => {
  it("are found tag by tag, weighted or not", () => {
    expect(wordsIn("1girl, (wtrclr style:1.2), smile", "wtrclr style, soft wash", "tags")).toEqual({ any: true, all: false });
    expect(wordsIn("1girl, Soft Wash, wtrclr style", "wtrclr style, soft wash", "tags")).toEqual({ any: true, all: true });
    expect(wordsIn("1girl, smile", "wtrclr style", "tags")).toEqual({ any: false, all: false });
    // not as a part of another tag
    expect(wordsIn("1girl, wtrclr style dress", "wtrclr style", "tags")).toEqual({ any: false, all: false });
    expect(wordsIn("A woman, in kr3a style, waves.", "kr3a style", "sentences")).toEqual({ any: true, all: true });
  });

  it("are added one by one: only the ones that are missing", () => {
    expect(appendTo("1girl, soft wash", "wtrclr style, soft wash", "tags")).toBe("1girl, soft wash, wtrclr style");
    expect(appendTo("1girl, soft wash, wtrclr style", "wtrclr style, soft wash", "tags")).toBe("1girl, soft wash, wtrclr style");
  });

  it("are taken out again, and the rest keeps its layout", () => {
    expect(removeFrom("1girl, (wtrclr style:1.2), smile, soft wash", "wtrclr style, soft wash", "tags")).toBe("1girl, smile");
    expect(removeFrom("wtrclr style, 1girl, smile", "wtrclr style", "tags")).toBe("1girl, smile");
    expect(removeFrom("1girl, smile\nwtrclr style, terrace", "wtrclr style", "tags")).toBe("1girl, smile\nterrace");
    expect(removeFrom("1girl, wtrclr style dress", "wtrclr style", "tags")).toBe("1girl, wtrclr style dress");
    expect(removeFrom("A woman waves. kr3a style", "kr3a style", "sentences")).toBe("A woman waves.");
    expect(removeFrom("In Kr3a  Style, a woman waves.", "kr3a style", "sentences")).toBe("In, a woman waves.");
  });
});
