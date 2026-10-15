import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { thumbUrl, type BrowseCard } from "../../src/api";
import { Card } from "../../src/findModels/Card";
import { Thumb, ThumbWidth } from "../../src/Thumb";
import { draw } from "./render";

// each card drawing says its downloads (format.ts compact): counted, the cards drawn are
const said = vi.hoisted(() => ({ downloads: [] as number[] }));
vi.mock("../../src/format", async (real) => {
  const format = await real<typeof import("../../src/format")>();
  return { ...format, compact: (n: number) => (said.downloads.push(n), format.compact(n)) };
});

describe("a tile's thumbnail", () => {
  it("is picked by the width its grid lays it out at, never by sizes=auto (Chrome keeps every such picture it drops)", () => {
    draw(
      <>
        <ThumbWidth.Provider value={210}><Thumb src={thumbUrl("a")} alt="in a grid" /></ThumbWidth.Provider>
        <Thumb src={thumbUrl("b")} alt="on its own" />
        <Thumb src={thumbUrl("c")} alt="small" sizes="40px" />
      </>,
    );
    expect(screen.getByAltText("in a grid").getAttribute("sizes")).toBe("210px");
    expect(screen.getByAltText("on its own").getAttribute("sizes")).toBe("320px");
    expect(screen.getByAltText("small").getAttribute("sizes")).toBe("40px");
    for (const img of screen.getAllByRole("img")) expect(img.getAttribute("sizes")).not.toContain("auto");
  });
});

const card = (id: string): BrowseCard => ({
  site: "civitai", id, name: `zz-test ${id}`, type: "LORA", base: "Illustrious", creator: "zz", downloads: Number(id), likes: 0, updatedAt: null, thumb: null, page: "",
  licence: { commercial: null, credit: false, derivatives: null }, fits: null, have: false, update: null, gated: false, versions: [],
});

describe("Find models' cards", () => {
  it("a card is not drawn again when a page is added after it, with the same callbacks", () => {
    const open = () => {};
    const quick = () => {};
    const list = (cards: BrowseCard[]) => cards.map((c) => <Card key={c.id} card={c} picked={false} onOpen={open} onQuick={quick} />);
    const first = [card("1"), card("2")];
    const { rerender } = draw(<>{list(first)}</>);
    said.downloads.length = 0;
    rerender(<>{list([...first, card("3")])}</>);
    expect(said.downloads).toEqual([3]);
  });
});
