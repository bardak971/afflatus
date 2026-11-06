import { describe, expect, it } from "vitest";
import {
  alphaOf, bounds, chase, clear, clip, combine, cut, dab, distanceOut, dropStrays, EMPTY_BELOW, falloff, feathered, fillPolygon, fillRect, fromRgba, History, insidePolygon, invert,
  line, newPlane, normal, paste, resample, toRgba, union, wand, workSize, WORK_EDGE, type Plane,
} from "../src/stageLayer/raster";

const at = (p: Plane, x: number, y: number) => p.data[y * p.w + x]!;
const sum = (p: Plane) => p.data.reduce((n, v) => n + v, 0);

describe("the work plane", () => {
  it("keeps a picture's own size when it fits, and scales a larger one to the edge on its long side", () => {
    expect(workSize(1216, 832)).toEqual({ w: 1216, h: 832, k: 1 });
    const big = workSize(4096, 2048);
    expect(big).toEqual({ w: WORK_EDGE, h: 1024, k: 0.5 });
    expect(workSize(3000, 5000).h).toBe(WORK_EDGE);
    expect(workSize(0, 0)).toEqual({ w: 1, h: 1, k: 1 });
  });

  it("clips and joins rects", () => {
    expect(clip({ x: -5, y: -5, w: 10, h: 10 }, { w: 8, h: 8 })).toEqual({ x: 0, y: 0, w: 5, h: 5 });
    expect(clip({ x: 9, y: 0, w: 4, h: 4 }, { w: 8, h: 8 })).toBeNull();
    expect(union(null, { x: 1, y: 1, w: 1, h: 1 })).toEqual({ x: 1, y: 1, w: 1, h: 1 });
    expect(union({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 3, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 6, h: 4 });
    expect(normal({ x: 10, y: 10, w: -4, h: -6 })).toEqual({ x: 6, y: 4, w: 4, h: 6 });
  });
});

describe("the soft brush", () => {
  it("fades from 1 at the core's edge to 0 at the feather's, without a step at either end", () => {
    expect(falloff(0, 10)).toBe(1);
    expect(falloff(10, 10)).toBe(0);
    expect(falloff(5, 10)).toBeCloseTo(0.5);
    expect(falloff(1, 10)).toBeGreaterThan(0.97);
    expect(falloff(9, 10)).toBeLessThan(0.03);
    expect(falloff(3, 0)).toBe(0);
  });

  it("is full inside its core and fades over its feather past it", () => {
    const p = newPlane(64, 64);
    const dirty = dab(p, 32, 32, 10, 8, "add");
    expect(at(p, 32, 32)).toBe(255);
    expect(at(p, 32 + 9, 32)).toBe(255);
    const mid = at(p, 32 + 14, 32);
    expect(mid).toBeGreaterThan(40);
    expect(mid).toBeLessThan(215);
    expect(at(p, 32 + 19, 32)).toBe(0);
    expect(at(p, 0, 0)).toBe(0);
    expect(dirty).toEqual({ x: 14, y: 14, w: 36, h: 36 });
  });

  it("with no feather, is hard edged", () => {
    const p = newPlane(32, 32);
    dab(p, 16, 16, 6, 0, "add");
    const values = new Set(p.data);
    expect([...values].sort()).toEqual([0, 255]);
  });

  it("a click with the smallest brush still marks the pixel under it", () => {
    const p = newPlane(8, 8);
    dab(p, 3.5, 3.5, 0, 0, "add");
    expect(at(p, 3, 3)).toBe(255);
    expect(sum(p)).toBe(255);
  });

  it("does not pile up where its dabs overlap: a stroke stays as soft as one dab", () => {
    const p = newPlane(64, 64);
    for (let i = 0; i < 10; i++) dab(p, 32, 32, 4, 12, "add");
    const once = newPlane(64, 64);
    dab(once, 32, 32, 4, 12, "add");
    expect(p.data).toEqual(once.data);
  });

  it("a dab off the plane touches nothing", () => {
    const p = newPlane(16, 16);
    expect(dab(p, -50, -50, 4, 2, "add")).toBeNull();
    expect(sum(p)).toBe(0);
  });

  it("a line covers the whole way between its points without gaps", () => {
    const p = newPlane(100, 20);
    const dirty = line(p, { x: 10, y: 10 }, { x: 90, y: 10 }, 3, 0, "add");
    for (let x = 10; x <= 90; x++) expect(at(p, x, 10)).toBe(255);
    expect(dirty!.x).toBeLessThanOrEqual(10);
    expect(dirty!.x + dirty!.w).toBeGreaterThanOrEqual(90);
  });

  it("a line can grow from one size to another (a pen pressed harder)", () => {
    const p = newPlane(120, 40);
    line(p, { x: 10, y: 20 }, { x: 110, y: 20 }, 2, 0, "add", 12);
    expect(at(p, 12, 20 + 6)).toBe(0);
    expect(at(p, 108, 20 + 8)).toBe(255);
  });

  it("the rubber takes away by its own softness", () => {
    const p = newPlane(64, 64);
    fillRect(p, { x: 0, y: 0, w: 64, h: 64 }, 0, "add");
    dab(p, 32, 32, 6, 8, "subtract");
    expect(at(p, 32, 32)).toBe(0);
    const edge = at(p, 32 + 10, 32);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    expect(at(p, 2, 2)).toBe(255);
  });
});

describe("fills", () => {
  it("a box fills its inside, either way it was drawn", () => {
    const p = newPlane(40, 40);
    fillRect(p, { x: 30, y: 30, w: -20, h: -10 }, 0, "add");
    expect(at(p, 10, 20)).toBe(255);
    expect(at(p, 29, 29)).toBe(255);
    expect(at(p, 30, 30)).toBe(0);
    expect(at(p, 9, 25)).toBe(0);
    expect(bounds(p)).toEqual({ x: 10, y: 20, w: 20, h: 10 });
  });

  it("a box's feather fades out past its edge, not into it", () => {
    const p = newPlane(60, 60);
    const dirty = fillRect(p, { x: 20, y: 20, w: 20, h: 20 }, 9, "add");
    expect(at(p, 20, 30)).toBe(255);
    const half = at(p, 15, 30);
    expect(half).toBeGreaterThan(60);
    expect(half).toBeLessThan(200);
    expect(at(p, 9, 30)).toBe(0);
    expect(dirty).toEqual({ x: 11, y: 11, w: 38, h: 38 });
  });

  it("measures the distance out of a shape within a few percent", () => {
    const hard = new Uint8Array(21 * 21);
    hard[10 * 21 + 10] = 1;
    const d = distanceOut(hard, 21, 21);
    expect(d[10 * 21 + 10]).toBe(0);
    expect(d[10 * 21 + 20]).toBeCloseTo(10, 5);
    // the diagonal: √2·10 ≈ 14.1, the chamfer says 13.3
    expect(Math.abs(d[20 * 21 + 20]! - 14.14) / 14.14).toBeLessThan(0.08);
  });

  it("a lasso fills its outline and leaves out where it crossed itself", () => {
    const square = [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }];
    expect(insidePolygon(square, 20, 20)).toBe(true);
    expect(insidePolygon(square, 5, 20)).toBe(false);
    const p = newPlane(40, 40);
    fillPolygon(p, square, 0, "add");
    expect(at(p, 20, 20)).toBe(255);
    expect(at(p, 35, 20)).toBe(0);
    const triangle = newPlane(40, 40);
    fillPolygon(triangle, [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 40 }], 0, "add");
    expect(at(triangle, 5, 5)).toBe(255);
    expect(at(triangle, 35, 35)).toBe(0);
    // a bow tie, its two loops left and right: they are in, above and below where it crosses is not
    const bow = newPlane(40, 40);
    fillPolygon(bow, [{ x: 0, y: 0 }, { x: 40, y: 40 }, { x: 40, y: 0 }, { x: 0, y: 40 }], 0, "add");
    expect(at(bow, 5, 20)).toBe(255);
    expect(at(bow, 34, 20)).toBe(255);
    expect(at(bow, 20, 5)).toBe(0);
  });

  it("a lasso of fewer than three points fills nothing", () => {
    const p = newPlane(10, 10);
    expect(fillPolygon(p, [{ x: 1, y: 1 }, { x: 8, y: 8 }], 3, "add")).toBeNull();
    expect(sum(p)).toBe(0);
  });

  it("a lasso feathers out past its edge, and can take away", () => {
    const p = newPlane(60, 60);
    fillRect(p, { x: 0, y: 0, w: 60, h: 60 }, 0, "add");
    fillPolygon(p, [{ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 40 }, { x: 20, y: 40 }], 6, "subtract");
    expect(at(p, 30, 30)).toBe(0);
    expect(at(p, 17, 30)).toBeGreaterThan(0);
    expect(at(p, 17, 30)).toBeLessThan(255);
    expect(at(p, 5, 5)).toBe(255);
  });
});

describe("invert, clear, and a mask from elsewhere", () => {
  it("inverts by the grey levels, and twice is as before", () => {
    const p = newPlane(4, 1);
    p.data.set([0, 40, 200, 255]);
    invert(p);
    expect([...p.data]).toEqual([255, 215, 55, 0]);
    invert(p);
    expect([...p.data]).toEqual([0, 40, 200, 255]);
    clear(p);
    expect(sum(p)).toBe(0);
  });

  it("adds a found mask by the most of the two, and takes one away by what it leaves", () => {
    const p = newPlane(4, 1);
    p.data.set([0, 100, 200, 255]);
    const other = newPlane(4, 1);
    other.data.set([0, 150, 50, 0]);
    expect(combine(p, other, "add")).toEqual({ x: 1, y: 0, w: 2, h: 1 });
    expect([...p.data]).toEqual([0, 150, 200, 255]);
    const away = newPlane(4, 1);
    away.data.set([255, 255, 100, 0]);
    combine(p, away, "subtract");
    expect([...p.data]).toEqual([0, 0, 155, 255]);
  });

  it("brings nothing from an empty mask, and refuses one of another size", () => {
    const p = newPlane(4, 4);
    expect(combine(p, newPlane(4, 4), "add")).toBeNull();
    expect(() => combine(p, newPlane(2, 2), "add")).toThrow(/2×2/);
  });

  it("gives a hard found mask a feather past its edge, leaving the mask it came as", () => {
    const hard = newPlane(40, 20);
    fillRect(hard, { x: 10, y: 5, w: 10, h: 10 }, 0, "add");
    const soft = feathered(hard, 6);
    expect(at(soft, 15, 10)).toBe(255);
    expect(at(soft, 22, 10)).toBeGreaterThan(0);
    expect(at(soft, 22, 10)).toBeLessThan(255);
    expect(at(soft, 30, 10)).toBe(0);
    expect(at(hard, 22, 10)).toBe(0);
    expect(feathered(hard, 0).data).toEqual(hard.data);
  });

  it("makes a soft found mask full inside its half-way edge, so its fade has no dip", () => {
    const soft = newPlane(30, 1);
    soft.data.set(Array.from({ length: 30 }, (_, x) => (x < 10 ? 200 : x < 14 ? 140 : 0)));
    const out = feathered(soft, 6);
    expect(out.data[12]).toBe(255);
    // past the edge it only falls, never rising again
    for (let x = 14; x < 29; x++) expect(out.data[x + 1]!).toBeLessThanOrEqual(out.data[x]!);
  });

  it("finds the masked part, the feather's last breath left out", () => {
    const p = newPlane(10, 10);
    expect(bounds(p)).toBeNull();
    p.data[3 * 10 + 2] = EMPTY_BELOW;
    expect(bounds(p)).toBeNull();
    p.data[3 * 10 + 2] = EMPTY_BELOW + 1;
    p.data[7 * 10 + 6] = 255;
    expect(bounds(p)).toEqual({ x: 2, y: 3, w: 5, h: 5 });
  });
});

describe("the mask in and out", () => {
  it("is read from a picture's red channel, and written as opaque grey", () => {
    const rgba = new Uint8ClampedArray([10, 0, 0, 255, 200, 99, 99, 0]);
    const p = fromRgba(rgba, 2, 1);
    expect([...p.data]).toEqual([10, 200]);
    expect([...toRgba(p)]).toEqual([10, 10, 10, 255, 200, 200, 200, 255]);
  });

  it("is scaled to the picture's own size, grey levels kept between", () => {
    const p = newPlane(2, 1);
    p.data.set([0, 255]);
    const up = resample(p, 8, 2);
    expect(up.w).toBe(8);
    expect(up.data.length).toBe(16);
    expect(up.data[0]).toBe(0);
    expect(up.data[7]).toBe(255);
    const middle = up.data[4]!;
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(255);
    // the same size: a copy, not the plane itself
    const same = resample(p, 2, 1);
    expect(same.data).not.toBe(p.data);
    expect([...same.data]).toEqual([0, 255]);
  });

  it("a hard mask scaled up and down keeps its part", () => {
    const p = newPlane(100, 50);
    fillRect(p, { x: 20, y: 10, w: 40, h: 20 }, 0, "add");
    const up = resample(p, 400, 200);
    expect(bounds(up, 127)).toEqual({ x: 80, y: 40, w: 160, h: 80 });
    const down = resample(up, 100, 50);
    expect(bounds(down, 127)).toEqual({ x: 20, y: 10, w: 40, h: 20 });
  });

  it("is shown as white as strong as the mask, a part alone when asked", () => {
    const p = newPlane(3, 2);
    p.data.set([0, 255, 128, 0, 0, 255]);
    const whole = alphaOf(p);
    expect(whole.rect).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    expect([...whole.data.slice(4, 12)]).toEqual([255, 255, 255, 255, 255, 255, 255, 128]);
    const part = alphaOf(p, { x: 2, y: 1, w: 1, h: 1 });
    expect([...part.data]).toEqual([255, 255, 255, 255]);
  });

  it("cuts a part out and pastes it back", () => {
    const p = newPlane(4, 4);
    p.data.forEach((_, i) => (p.data[i] = i));
    const r = { x: 1, y: 1, w: 2, h: 2 };
    const piece = cut(p, r);
    expect([...piece]).toEqual([5, 6, 9, 10]);
    clear(p);
    paste(p, r, piece);
    expect(at(p, 2, 2)).toBe(10);
    expect(at(p, 0, 0)).toBe(0);
  });
});

describe("undo by patches", () => {
  it("takes a stroke back and puts it again, keeping only the part it touched", () => {
    const p = newPlane(200, 200);
    const h = new History();
    h.begin(p);
    const dirty = dab(p, 50, 50, 5, 2, "add");
    h.commit(p, dirty);
    expect(h.steps).toBe(1);
    const painted = p.data.slice();
    expect(h.undo(p)).toEqual(dirty);
    expect(sum(p)).toBe(0);
    expect(h.redos).toBe(1);
    expect(h.redo(p)).toEqual(dirty);
    expect(p.data).toEqual(painted);
  });

  it("a stroke that changed nothing is not a step, and a new one drops what was undone", () => {
    const p = newPlane(20, 20);
    const h = new History();
    h.begin(p);
    h.commit(p, dab(p, 5, 5, 2, 0, "subtract"));
    expect(h.steps).toBe(0);
    h.begin(p);
    h.commit(p, dab(p, 5, 5, 2, 0, "add"));
    h.undo(p);
    expect(h.redos).toBe(1);
    h.begin(p);
    h.commit(p, dab(p, 10, 10, 2, 0, "add"));
    expect(h.redos).toBe(0);
    expect(h.steps).toBe(1);
    expect(h.undo(p)).not.toBeNull();
    expect(h.undo(p)).toBeNull();
    expect(h.redo(p)).not.toBeNull();
    expect(h.redo(p)).toBeNull();
  });

  it("forgets the oldest steps past its count or its bytes", () => {
    const p = newPlane(50, 50);
    const few = new History(Infinity, 3);
    for (let i = 0; i < 5; i++) {
      few.begin(p);
      few.commit(p, dab(p, 5 + i * 8, 5, 2, 0, "add"));
    }
    expect(few.steps).toBe(3);
    const small = new History(2 * 50 * 50 * 2 - 1, 100);
    for (let i = 0; i < 3; i++) {
      small.begin(p);
      small.commit(p, invert(p));
    }
    expect(small.steps).toBe(1);
  });

  it("a stroke cut short leaves the plane as it was, and no step", () => {
    const p = newPlane(20, 20);
    const h = new History();
    expect(h.abandon(p)).toBeNull();
    h.begin(p);
    dab(p, 10, 10, 4, 2, "add");
    expect(h.abandon(p)).toEqual({ x: 0, y: 0, w: 20, h: 20 });
    expect(sum(p)).toBe(0);
    expect(h.steps).toBe(0);
  });

  it("a whole-plane change (invert) undoes as one step", () => {
    const p = newPlane(10, 10);
    dab(p, 5, 5, 2, 0, "add");
    const before = p.data.slice();
    const h = new History();
    h.begin(p);
    h.commit(p, invert(p));
    h.undo(p);
    expect(p.data).toEqual(before);
  });
});

describe("the magic wand", () => {
  /** A picture of `w` × `h` grey pixels, from rows of grey levels. */
  const picture = (rows: number[][]) => {
    const h = rows.length;
    const w = rows[0]!.length;
    const rgba = new Uint8ClampedArray(w * h * 4);
    rows.flat().forEach((v, i) => rgba.set([v, v, v, 255], i * 4));
    return { rgba, w, h };
  };
  const ones = (p: Plane) => [...p.data].map((v) => (v ? 1 : 0)).join("");

  it("takes the same colour reached from the click, and not the same colour cut off from it", () => {
    const { rgba, w, h } = picture([
      [10, 10, 200, 10],
      [10, 200, 200, 10],
      [200, 200, 10, 10],
    ]);
    expect(ones(wand(rgba, w, h, 0, 0, 0, true))).toBe("110010000000");
    // the whole picture: the right-hand 10s too
    expect(ones(wand(rgba, w, h, 0, 0, 0, false))).toBe("110110010011");
  });

  it("takes colours within the tolerance, the edge itself included", () => {
    // 51 is 20 % of 255: 100 and 151 are 51 apart
    const { rgba, w, h } = picture([[100, 151, 152, 49]]);
    expect(ones(wand(rgba, w, h, 0, 0, 20, true))).toBe("1100");
    expect(ones(wand(rgba, w, h, 0, 0, 20, false))).toBe("1101");
    expect(ones(wand(rgba, w, h, 0, 0, 0, false))).toBe("1000");
    expect(ones(wand(rgba, w, h, 0, 0, 100, true))).toBe("1111");
  });

  it("reads each channel: a colour as light but of another hue is not close", () => {
    const rgba = new Uint8ClampedArray([200, 0, 0, 255, 0, 200, 0, 255, 190, 10, 5, 255]);
    expect(ones(wand(rgba, 3, 1, 0, 0, 10, false))).toBe("101");
  });

  it("finds nothing off the picture, and fills a large part without running out of stack", () => {
    const flat = new Uint8ClampedArray(2048 * 512 * 4).fill(128);
    expect(bounds(wand(flat, 2048, 512, -1, 5, 50, true))).toBeNull();
    expect(bounds(wand(flat, 2048, 512, 1000, 200, 0, true))).toEqual({ x: 0, y: 0, w: 2048, h: 512 });
  });
});

describe("a found mask's strays", () => {
  // a 200 × 200 part (the thing clicked) and what else SAM's answer may hold
  const found = () => {
    const p = newPlane(400, 300);
    fillRect(p, { x: 20, y: 40, w: 200, h: 200 }, 0, "add");
    return p;
  };

  it("drops a speck far from the thing (card #274's pod: 73 pixels on the other bicycle)", () => {
    const p = found();
    fillRect(p, { x: 330, y: 100, w: 8, h: 9 }, 0, "add");
    dropStrays(p);
    expect(at(p, 333, 104)).toBe(0);
    expect(bounds(p)).toEqual({ x: 20, y: 40, w: 200, h: 200 });
  });

  it("keeps a small piece inside the thing's box, a large one outside it, and a single part as it is", () => {
    const p = found();
    // a spoke cut off from the frame, within the wheel's box
    fillRect(p, { x: 100, y: 100, w: 4, h: 4 }, 0, "add");
    p.data.fill(0, 102 * 400 + 60, 102 * 400 + 160);
    // a second thing clicked, of a size with the first
    fillRect(p, { x: 260, y: 40, w: 120, h: 120 }, 0, "add");
    const before = sum(p);
    dropStrays(p);
    expect(sum(p)).toBe(before);
    const one = found();
    expect(sum(dropStrays(one))).toBe(200 * 200 * 255);
  });

  it("reads a soft edge's faint pixels as part of what they surround, not as specks", () => {
    const p = newPlane(400, 300);
    fillRect(p, { x: 20, y: 40, w: 200, h: 200 }, 12, "add");
    const before = sum(p);
    expect(sum(dropStrays(p))).toBe(before);
  });
});

describe("the mask as shown, chasing the mask", () => {
  it("moves each pixel of the part by at most a step toward the plane, both ways, and says when all of it arrived", () => {
    const p = newPlane(4, 1);
    p.data.set([255, 0, 100, 40]);
    const shown = new Uint8ClampedArray([0, 255, 100, 0]);
    const all = { x: 0, y: 0, w: 4, h: 1 };
    expect(chase(shown, p, all, 100)).toBe(false);
    expect([...shown]).toEqual([100, 155, 100, 40]);
    expect(chase(shown, p, all, 100)).toBe(false);
    expect(chase(shown, p, all, 100)).toBe(true);
    expect([...shown]).toEqual([...p.data]);
    // only the part asked: the rest as it was shown
    const part = new Uint8ClampedArray(4);
    expect(chase(part, p, { x: 2, y: 0, w: 2, h: 1 }, 255)).toBe(true);
    expect([...part]).toEqual([0, 0, 100, 40]);
    // the plane itself is never written: what is sent stays what was painted
    expect([...p.data]).toEqual([255, 0, 100, 40]);
  });
});
