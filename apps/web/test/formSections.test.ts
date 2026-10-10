import { describe, expect, it } from "vitest";
import type { Section } from "@afflatus/workflows";
import { ADVANCED, cardMoved, cardsOf, locate, placedIn, PROMPT, reordered, stopsOf, withNew, without } from "../src/screens/workflowEditor/sections";

const sec = (id: string, items: Section["items"] = []): Section => ({ id, label: id.toUpperCase(), items });
const group = (toggle: string, items: string[]) => ({ toggle, items });
const ids = (list: Section[] | null) => list?.map((s) => s.id) ?? null;

describe("withNew", () => {
  it("adds the new section last, numbered after the author's own", () => {
    const { next, made } = withNew([sec("a"), sec("b")], "n");
    expect(ids(next)).toEqual(["a", "b", "n"]);
    expect(made).toEqual({ id: "n", label: "Section 3", items: [] });
  });
  it("puts it before the first mark, so a moved-up Advanced stays where it was put", () => {
    const { next, made } = withNew([sec(PROMPT), sec("a"), sec(ADVANCED), sec("b")], "n");
    expect(ids(next)).toEqual(["n", PROMPT, "a", ADVANCED, "b"]);
    // the marks are not counted as sections
    expect(made.label).toBe("Section 3");
  });
});

describe("without", () => {
  it("takes an item out of every section and every switch", () => {
    const out = without([sec("a", ["x", "y"]), sec("b", [group("s", ["x", "z"])])], "x");
    expect(out.map((s) => s.items)).toEqual([["y"], [group("s", ["z"])]]);
  });
  it("takes a switch out whole, its settings with it", () => {
    expect(without([sec("a", ["y", group("s", ["x"])])], "s")[0]!.items).toEqual(["y"]);
  });
});

describe("placedIn", () => {
  const start = [sec("a", ["x", "y"]), sec("b", [group("s", ["z"])])];
  it("moves an item to a spot in another section", () => {
    expect(placedIn(start, "x", { section: "b", group: null, index: 0 })?.map((s) => s.items)).toEqual([["y"], ["x", group("s", ["z"])]]);
  });
  it("moves an item under a switch, at its index", () => {
    expect(placedIn(start, "y", { section: "b", group: "s", index: 0 })?.map((s) => s.items)).toEqual([["x"], [group("s", ["y", "z"])]]);
  });
  it("clamps an index past the end to the end", () => {
    expect(placedIn(start, "x", { section: "a", group: null, index: 99 })?.[0]!.items).toEqual(["y", "x"]);
  });
  it("puts the item out of every section when there is no spot", () => {
    expect(placedIn(start, "z", null)?.map((s) => s.items)).toEqual([["x", "y"], [group("s", [])]]);
  });
  it("moves a switch with its settings, and never under another switch", () => {
    expect(placedIn(start, "s", { section: "a", group: null, index: 1 })?.map((s) => s.items)).toEqual([["x", group("s", ["z"]), "y"], []]);
    expect(placedIn(start, "s", { section: "b", group: "s", index: 0 })).toBeNull();
  });
});

describe("reordered", () => {
  it("puts a section just before another", () => {
    expect(ids(reordered([sec("a"), sec("b"), sec("c")], "c", "a"))).toEqual(["c", "a", "b"]);
  });
  it("refuses a section dropped on itself or an unknown one", () => {
    expect(reordered([sec("a"), sec("b")], "a", "a")).toBeNull();
    expect(reordered([sec("a"), sec("b")], "zz", "a")).toBeNull();
    expect(reordered([sec("a"), sec("b")], "a", "zz")).toBeNull();
  });
  it("adds the Advanced mark the first time it is moved", () => {
    expect(ids(reordered([sec("a"), sec("b")], ADVANCED, "b"))).toEqual(["a", ADVANCED, "b"]);
  });
  it("adds a missing mark where its card stood when a section is dropped on it: Prompt first, Advanced last", () => {
    expect(ids(reordered([sec("a"), sec("b")], "b", PROMPT))).toEqual(["b", PROMPT, "a"]);
    expect(ids(reordered([sec("a"), sec("b")], "a", ADVANCED))).toEqual(["b", "a", ADVANCED]);
  });
});

describe("locate, stops and cards", () => {
  const list = [sec("a", ["x", group("s", ["y", "z"])]), sec("b")];
  it("finds an item, a switch and a setting under a switch", () => {
    expect(locate(list, "x")).toMatchObject({ section: { id: "a" }, group: null, index: 0, size: 2 });
    expect(locate(list, "s")).toMatchObject({ section: { id: "a" }, group: null, index: 1, size: 2 });
    expect(locate(list, "z")).toMatchObject({ section: { id: "a" }, group: { toggle: "s" }, index: 1, size: 2 });
    expect(locate(list, "nope")).toBeNull();
  });
  it("walks the sections with Advanced among them, never the Prompt", () => {
    expect(stopsOf(list)).toEqual(["a", "b", ADVANCED]);
    expect(stopsOf([sec(PROMPT), sec(ADVANCED), sec("a")])).toEqual([ADVANCED, "a"]);
  });
  it("draws the Prompt and Advanced cards around the author's sections", () => {
    expect(cardsOf(list)).toEqual([PROMPT, "a", "b", ADVANCED]);
    expect(cardsOf([])).toEqual([]);
  });
});

describe("cardMoved", () => {
  const list = [sec("a"), sec("b"), sec("c")];
  it("moves a card up and down", () => {
    expect(ids(cardMoved(list, "b", "up"))).toEqual(["b", "a", "c"]);
    expect(ids(cardMoved(list, "b", "down"))).toEqual(["a", "c", "b"]);
  });
  it("moves the Prompt card down: its mark joins the list", () => {
    expect(ids(cardMoved(list, PROMPT, "down"))).toEqual(["a", PROMPT, "b", "c"]);
  });
  it("moves a card to the top and to the bottom, past the cards drawn there", () => {
    expect(ids(cardMoved(list, "c", "top"))).toEqual(["c", PROMPT, "a", "b"]);
    expect(ids(cardMoved(list, "a", "bottom"))).toEqual(["b", "c", ADVANCED, "a"]);
  });
  it("does nothing at either end", () => {
    expect(cardMoved(list, PROMPT, "up")).toBeNull();
    expect(cardMoved(list, ADVANCED, "bottom")).toBeNull();
  });
});
