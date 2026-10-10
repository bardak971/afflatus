import { describe, expect, it } from "vitest";
import { justify } from "../src/screens/library/justify";
import { drawnGroups, drawnIndices, layGroups, meeting, nextSpan, placeRows, stackBands, type Band } from "../src/screens/studio/virtual";

// rows of 100 px, 10 px apart: row i from 110 i to 110 i + 100
const bands: Band[] = stackBands(Array.from({ length: 50 }, () => 100), 10);

describe("the grid drawn only where it is seen", () => {
  it("places justified rows one under the other, every tile in its row's band", () => {
    const shapes = Array.from({ length: 400 }, (_, i) => [1.5, 0.75, 1, 16 / 9, 2 / 3][i % 5]!);
    const rows = justify(shapes, 1200, 210, 8);
    const { at, bands: placed, height } = placeRows(rows, 20, 8);
    expect(at).toHaveLength(400);
    rows.forEach((r, k) => {
      for (let i = r.start; i < r.end; i++) {
        expect(at[i]!.top).toBe(placed[k]!.top);
        expect(at[i]!.height).toBe(r.height + 20);
      }
      if (k) expect(placed[k]!.top).toBe(placed[k - 1]!.bottom + 8);
    });
    expect(height).toBe(placed.at(-1)!.bottom);
    expect(placeRows([], 0, 8).height).toBe(0);
  });

  it("finds the rows that meet a window, the gaps between them meeting none", () => {
    expect(meeting(bands, 0, 1)).toEqual({ first: 0, end: 1 });
    expect(meeting(bands, 105, 108)).toEqual({ first: 1, end: 1 });
    expect(meeting(bands, 150, 400)).toEqual({ first: 1, end: 4 });
    expect(meeting(bands, -500, 50)).toEqual({ first: 0, end: 1 });
    expect(meeting(bands, 5400, 9000)).toEqual({ first: 49, end: 50 });
    expect(meeting(bands, 6000, 9000)).toEqual({ first: 50, end: 50 });
    expect(meeting([], 0, 1000)).toEqual({ first: 0, end: 0 });
  });

  it("draws the view and a margin each way, and keeps the rows drawn while they still cover half of it", () => {
    const at0 = nextSpan(null, bands, 0, 1000, 1000);
    expect(at0).toEqual(meeting(bands, -1000, 2000));
    // a little further down: the rows drawn still cover the view and half the margin, nothing is drawn again
    expect(nextSpan(at0, bands, 300, 1300, 1000)).toBe(at0);
    // past half the margin: drawn again around the new view
    const later = nextSpan(at0, bands, 700, 1700, 1000);
    expect(later).not.toBe(at0);
    expect(later).toEqual(meeting(bands, -300, 2700));
    // a jump far down (the scrollbar dragged) draws only around the new view
    expect(nextSpan(at0, bands, 4000, 5000, 1000)).toEqual(meeting(bands, 3000, 6000));
  });

  it("draws again when the rows change under the ones drawn", () => {
    const drawn = nextSpan(null, bands, 3000, 4000, 1000);
    const fewer = bands.slice(0, 20);
    expect(nextSpan(drawn, fewer, 3000, 4000, 1000)).toEqual(meeting(fewer, 2000, 5000));
    // a list that was empty gets its first page
    expect(nextSpan({ first: 0, end: 0 }, bands, 0, 1000, 1000)).toEqual(meeting(bands, -1000, 2000));
  });

  it("lets go of rows far from the view, and draws none of a list scrolled past", () => {
    const big = { first: 0, end: 40 };
    expect(nextSpan(big, bands, 0, 300, 200)).toEqual(meeting(bands, -200, 500));
    // a short list (a day's section) drawn, then scrolled far above the view: nothing of it is drawn any more
    const short = bands.slice(0, 2);
    const drawn = nextSpan(null, short, 0, 1000, 1000);
    expect(drawn).toEqual({ first: 0, end: 2 });
    expect(nextSpan(drawn, short, 5000, 6000, 1000)).toEqual({ first: 2, end: 2 });
    // and nothing drawn stays nothing while the list is still out of reach
    const none = { first: 2, end: 2 };
    expect(nextSpan(none, short, 5100, 6100, 1000)).toBe(none);
  });

  it("draws the tiles of the rows in view, and the one focused or dragged wherever it is, in the list's order", () => {
    const rows = [{ start: 0, end: 3 }, { start: 3, end: 5 }, { start: 5, end: 9 }, { start: 9, end: 10 }];
    expect(drawnIndices(rows, { first: 1, end: 3 }, [])).toEqual([3, 4, 5, 6, 7, 8]);
    expect(drawnIndices(rows, { first: 1, end: 2 }, [9, 0, 4, -1])).toEqual([0, 3, 4, 9]);
    expect(drawnIndices(rows, { first: 0, end: 0 }, [])).toEqual([]);
    expect(drawnIndices(rows, { first: 0, end: 0 }, [2])).toEqual([2]);
    // the rows of a section scrolled past: none, at whichever end it is
    expect(drawnIndices(rows, { first: 4, end: 4 }, [])).toEqual([]);
    expect(drawnIndices(rows, { first: 2, end: 2 }, [7])).toEqual([7]);
  });

  it("lays sections out one under the other, each heading a band of its own, every item of the whole list once", () => {
    const shapes = [[1.5, 0.75, 1, 1.5, 0.75, 1, 1.5], [1, 1], [16 / 9, 0.75, 1, 1, 1.5, 0.75, 2, 1, 1, 0.8, 1.2]];
    const laid = layGroups(shapes.map((s) => ({ rows: justify(s, 900, 200, 8), head: 25 })), { gap: 8, headGap: 8, groupGap: 16 });
    expect(laid.at).toHaveLength(20);
    // each section: the room above it, its heading, the room under it, its rows
    expect(laid.groups[0]!.top).toBe(16);
    expect(laid.groups[0]!.body).toBe(33);
    expect(laid.groups[1]!.top).toBe(laid.groups[0]!.top + laid.groups[0]!.height + 16);
    expect(laid.height).toBe(laid.groups[2]!.top + laid.groups[2]!.height);
    expect(laid.groups.map((g) => [g.first, g.end])).toEqual([[0, 7], [7, 9], [9, 20]]);
    // the bands are in order and cover every item once: the headings hold none
    laid.bands.forEach((b, k) => k && expect(b.top).toBeGreaterThanOrEqual(laid.bands[k - 1]!.bottom));
    expect(laid.bandOf.flatMap((b) => Array.from({ length: b.end - b.first }, (_, i) => b.first + i))).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(laid.bandOf.filter((b) => b.first === b.end)).toHaveLength(3);
    // a tile's box is from its section's body: the first row of each starts at 0
    expect(laid.at[7]!.top).toBe(0);
    // with no heading, as the plain grid: no room above, the rows as placeRows has them
    const plain = layGroups([{ rows: justify(shapes[0]!, 900, 200, 8), head: 0 }], { gap: 8, headGap: 8, groupGap: 16 });
    const rows = placeRows(justify(shapes[0]!, 900, 200, 8), 0, 8);
    expect(plain.at).toEqual(rows.at);
    expect(plain.bands).toEqual(rows.bands);
    expect(plain.height).toBe(rows.height);
  });

  it("draws only the sections with a band in view, and the one holding the focused item", () => {
    const laid = layGroups([[1, 1, 1], [1, 1], [1, 1, 1, 1]].map((s) => ({ rows: justify(s, 300, 100, 8), head: 25 })), { gap: 8, headGap: 8, groupGap: 16 });
    const mid = laid.bands.findIndex((_, k) => laid.bandOf[k]!.group === 1);
    // the second section's heading alone in view: it is drawn, with no tile
    expect(drawnGroups(laid, { first: mid, end: mid + 1 }, [])).toEqual([{ group: 1, items: [] }]);
    // its rows in view, and an item of the last section held
    expect(drawnGroups(laid, { first: mid, end: mid + 2 }, [8])).toEqual([{ group: 1, items: [3, 4] }, { group: 2, items: [8] }]);
    expect(drawnGroups(laid, { first: 0, end: 0 }, [])).toEqual([]);
  });
});
