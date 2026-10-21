import { describe, expect, it, vi } from "vitest";
import { editKey, playbackKey, selectionKey, type KeyActions, type KeyPlace } from "../src/timeline/editorKeys";
import type { TimeRange } from "../src/timeline/model";

/** A key as the window hears it: what `editorKeys` reads of it, and whether it was taken. */
function key(k: string, o: Partial<{ code: string; shift: boolean; ctrl: boolean; alt: boolean; repeat: boolean }> = {}) {
  return {
    key: k, code: o.code ?? "", shiftKey: Boolean(o.shift), ctrlKey: Boolean(o.ctrl), metaKey: false, altKey: Boolean(o.alt), repeat: Boolean(o.repeat),
    defaultPrevented: false,
    preventDefault: vi.fn(function (this: { defaultPrevented: boolean }) { this.defaultPrevented = true; }),
  } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

/** Where the key lands: the page itself unless told (in a field, a dialog open, an element that keeps Escape). */
function place(o: Partial<KeyPlace> & { inside?: string } = {}): KeyPlace {
  const el = { closest: (sel: string) => (o.inside && sel.includes(o.inside) ? {} : null) } as unknown as HTMLElement;
  const typing = o.typing ?? false;
  const open = o.open ?? false;
  return { el, typing, open, held: o.held ?? open, designing: o.designing ?? false, plain: o.plain ?? (!typing && !open) };
}

/** The editor's actions, each a spy, around a timeline 10 s long with the playhead at 2 s. */
function editor(o: Partial<{ range: TimeRange | null; selected: string | null; removing: boolean; canUndo: boolean; picked: boolean; at: number; where: () => unknown; source: boolean }> = {}) {
  let range = o.range ?? null;
  const seek = vi.fn();
  const a = {
    clock: { get: () => o.at ?? 2000, set: vi.fn(), subscribe: () => () => {} },
    player: { current: { seek, fullscreen: vi.fn(), where: o.where ?? (() => null) } },
    toggle: vi.fn(), undo: vi.fn(), canUndo: o.canUndo ?? true, redo: vi.fn(), canRedo: true,
    remove: vi.fn(), move: vi.fn(), removePicked: vi.fn(() => Boolean(o.picked)), removing: { current: o.removing ?? false },
    rangeRef: { get current() { return range; } },
    setRange: vi.fn((next: TimeRange | null | ((r: TimeRange | null) => TimeRange | null)) => { range = typeof next === "function" ? next(range) : next; }),
    totalRef: { current: 10_000 },
    toggleLoopNow: { current: vi.fn() },
    frameRef: { current: () => 1000 / 24 },
    selectedNow: { current: o.selected ?? null },
    musicOpenNow: { current: false }, closeMusicNow: { current: vi.fn() }, removeOpenNow: { current: vi.fn(() => false) },
    renderNow: { current: vi.fn() }, jumpNow: { current: vi.fn() }, splitNow: { current: vi.fn() }, takeNow: { current: vi.fn() },
    trackKeys: { current: { zoom: vi.fn(), fit: vi.fn() } },
    sourceMarkNow: { current: o.source ? vi.fn(() => true) : undefined },
    setSelected: vi.fn(), setPicked: vi.fn(),
  };
  return { a: a as unknown as KeyActions & typeof a, seek, range: () => range };
}

describe("the timeline editor's keys: playing and moving about", () => {
  it("plays with Space, except in a field or on a button (which clicks itself)", () => {
    const { a } = editor();
    expect(playbackKey(key(" ", { code: "Space" }), place(), a)).toBe(true);
    expect(a.toggle).toHaveBeenCalledOnce();
    expect(playbackKey(key(" ", { code: "Space" }), place({ typing: true }), a)).toBe(false);
    expect(playbackKey(key(" ", { code: "Space" }), place({ inside: "button" }), a)).toBe(false);
    expect(a.toggle).toHaveBeenCalledOnce();
  });

  it("marks In and Out at the playhead, one alone reaching to the end or from the start, and Shift goes to them", () => {
    const { a, seek, range } = editor({ at: 2000 });
    playbackKey(key("i"), place(), a);
    expect(range()).toEqual({ inMs: 2000, outMs: 10_000 });
    a.clock.get = () => 6000;
    playbackKey(key("o"), place(), a);
    expect(range()).toEqual({ inMs: 2000, outMs: 6000 });
    // In past Out moves Out along: never a range backwards
    a.clock.get = () => 8000;
    playbackKey(key("i"), place(), a);
    expect(range()).toEqual({ inMs: 8000, outMs: 8000 });
    playbackKey(key("O", { shift: true }), place(), a);
    expect(seek).toHaveBeenLastCalledWith(8000);
    const fresh = editor({ at: 3000 });
    playbackKey(key("o"), place(), fresh.a);
    expect(fresh.range()).toEqual({ inMs: 0, outMs: 3000 });
  });

  it("with the source on the stage, gives I and O to the source's In and Out, the range left as it was", () => {
    const { a, range } = editor({ source: true });
    expect(playbackKey(key("i"), place(), a)).toBe(true);
    expect(playbackKey(key("o"), place(), a)).toBe(true);
    expect(a.sourceMarkNow.current).toHaveBeenNthCalledWith(1, "in");
    expect(a.sourceMarkNow.current).toHaveBeenNthCalledWith(2, "out");
    expect(range()).toBeNull();
    // held down, each marks once: a repeat would send the source's trim again before the last one is back
    playbackKey(key("i", { repeat: true }), place(), a);
    playbackKey(key("o", { repeat: true }), place(), a);
    expect(a.sourceMarkNow.current).toHaveBeenCalledTimes(2);
  });

  it("loops only with a range, and leaves I, O and L to a field", () => {
    const none = editor();
    expect(playbackKey(key("l"), place(), none.a)).toBe(false);
    const { a } = editor({ range: { inMs: 0, outMs: 4000 } });
    expect(playbackKey(key("l"), place(), a)).toBe(true);
    expect(a.toggleLoopNow.current).toHaveBeenCalledOnce();
    expect(playbackKey(key("i"), place({ typing: true }), a)).toBe(false);
    expect(a.setRange).not.toHaveBeenCalled();
  });

  it("steps a frame by the arrows (ten with Shift), within the video, and not from In or Out's own handle", () => {
    const { a, seek } = editor({ at: 2000 });
    playbackKey(key("ArrowRight"), place(), a);
    expect(seek.mock.calls[0]![0]).toBeCloseTo(2000 + 1000 / 24, 6);
    playbackKey(key("ArrowLeft", { shift: true }), place(), a);
    expect(seek.mock.calls[1]![0]).toBeCloseTo(2000 - 10_000 / 24, 6);
    const end = editor({ at: 9990 });
    playbackKey(key("."), place(), end.a);
    expect(end.seek).toHaveBeenLastCalledWith(10_000);
    expect(playbackKey(key("ArrowRight"), place({ inside: "[aria-label=In]" }), a)).toBe(false);
  });

  it("steps by the frame shown in the clip's own file: to the middle of the next one", () => {
    // the clip starts at 1 s on the timeline and plays its file from 0.5 s: the playhead at 2 s shows the file at 1.5 s
    const where = () => ({ clip: { atMs: 1000 } as never, localMs: 1000, assetMs: 1500 });
    const { a, seek } = editor({ at: 2000, where });
    playbackKey(key("ArrowRight"), place(), a);
    // 1.5 s of a 24 fps file is frame 36; the step lands in frame 37's middle (1562.5 ms of the file), 2062.5 on the timeline
    expect(seek.mock.calls[0]![0]).toBeCloseTo(2062.5, 6);
  });

  it("zooms with - and =, fits with Shift+Z, jumps clips with [ and ], and goes to the ends with Home and End", () => {
    const { a, seek } = editor();
    playbackKey(key("="), place(), a);
    playbackKey(key("-"), place(), a);
    playbackKey(key("Z", { shift: true }), place(), a);
    expect(a.trackKeys.current!.zoom).toHaveBeenNthCalledWith(1, 1);
    expect(a.trackKeys.current!.zoom).toHaveBeenNthCalledWith(2, -1);
    expect(a.trackKeys.current!.fit).toHaveBeenCalledOnce();
    playbackKey(key("]"), place(), a);
    expect(a.jumpNow.current).toHaveBeenCalledWith(1);
    playbackKey(key("End"), place(), a);
    expect(seek).toHaveBeenLastCalledWith(10_000);
    // a slider keeps Home and End for itself
    expect(playbackKey(key("Home"), place({ inside: "[role=slider]" }), a)).toBe(false);
  });
});

describe("the timeline editor's keys: editing the clips", () => {
  it("undoes and redoes, not in a field, and only with something to undo", () => {
    const { a } = editor();
    expect(editKey(key("z", { ctrl: true }), place({ plain: false }), a)).toBe(true);
    expect(a.undo).toHaveBeenCalledOnce();
    expect(editKey(key("Z", { ctrl: true, shift: true }), place({ plain: false }), a)).toBe(true);
    expect(editKey(key("y", { ctrl: true }), place({ plain: false }), a)).toBe(true);
    expect(a.redo).toHaveBeenCalledTimes(2);
    expect(editKey(key("z", { ctrl: true }), place({ typing: true }), a)).toBe(false);
    const nothing = editor({ canUndo: false });
    expect(editKey(key("z", { ctrl: true }), place({ plain: false }), nothing.a)).toBe(false);
  });

  it("renders with Ctrl+Enter once a press, never from the designer's box", () => {
    const { a } = editor();
    editKey(key("Enter", { ctrl: true }), place({ plain: false }), a);
    editKey(key("Enter", { ctrl: true, repeat: true }), place({ plain: false }), a);
    editKey(key("Enter", { ctrl: true }), place({ typing: true, designing: true }), a);
    expect(a.renderNow.current).toHaveBeenCalledOnce();
  });

  it("splits with S or Ctrl+B and steps takes with Alt+[ and Alt+], once a press", () => {
    const { a } = editor();
    editKey(key("s"), place(), a);
    editKey(key("s", { repeat: true }), place(), a);
    editKey(key("b", { ctrl: true }), place({ plain: false }), a);
    expect(a.splitNow.current).toHaveBeenCalledTimes(2);
    // Alt changes what some keyboards type on the bracket keys: the key's place is read too
    editKey(key("“", { code: "BracketLeft", alt: true }), place({ plain: false }), a);
    editKey(key("]", { alt: true, repeat: true }), place({ plain: false }), a);
    expect(a.takeNow.current).toHaveBeenCalledOnce();
    expect(a.takeNow.current).toHaveBeenCalledWith(-1);
  });

  it("moves the selected clip with Alt and an arrow, and nothing without one selected", () => {
    const none = editor();
    expect(editKey(key("ArrowLeft", { alt: true }), place({ plain: false }), none.a)).toBe(false);
    const { a } = editor({ selected: "c2" });
    editKey(key("ArrowRight", { alt: true }), place({ plain: false }), a);
    expect(a.move).toHaveBeenCalledWith("c2", 1);
  });

  it("removes the picked clips, else the selected one, else what is open in the column", () => {
    const picked = editor({ picked: true, selected: "c1" });
    editKey(key("Delete"), place(), picked.a);
    expect(picked.a.removePicked).toHaveBeenCalledOnce();
    expect(picked.a.remove).not.toHaveBeenCalled();
    const one = editor({ selected: "c1" });
    editKey(key("Delete"), place(), one.a);
    expect(one.a.remove).toHaveBeenCalledWith("c1");
    const column = editor();
    editKey(key("Delete"), place(), column.a);
    expect(column.a.removeOpenNow.current).toHaveBeenCalledOnce();
  });

  it("removes once when Delete is held down or pressed again before the removal is back (W-9)", () => {
    const { a } = editor({ selected: "c1" });
    const held = key("Delete", { repeat: true });
    expect(editKey(held, place(), a)).toBe(true);
    expect(held.preventDefault).toHaveBeenCalled();
    expect(a.remove).not.toHaveBeenCalled();
    const busy = editor({ selected: "c1", removing: true, picked: true });
    editKey(key("Delete"), place(), busy.a);
    expect(busy.a.remove).not.toHaveBeenCalled();
    expect(busy.a.removePicked).not.toHaveBeenCalled();
    // pressed twice in a row, before the editor draws the removal under way: once
    const twice = editor({ selected: "c1" });
    editKey(key("Delete"), place(), twice.a);
    editKey(key("Delete"), place(), twice.a);
    expect(twice.a.remove).toHaveBeenCalledOnce();
  });
});

describe("the timeline editor's keys: letting go", () => {
  it("lets go of one thing an Escape: the range (and the picked clips), then the clip, then the music's panel", () => {
    const { a, range } = editor({ range: { inMs: 0, outMs: 1000 }, selected: "c1" });
    a.musicOpenNow.current = true;
    selectionKey(key("Escape"), place(), a);
    expect(range()).toBeNull();
    expect(a.setPicked).toHaveBeenCalledOnce();
    expect(a.setSelected).not.toHaveBeenCalled();
    selectionKey(key("Escape"), place(), a);
    expect(a.setSelected).toHaveBeenCalledWith(null);
    a.selectedNow.current = null;
    selectionKey(key("Escape"), place(), a);
    expect(a.closeMusicNow.current).toHaveBeenCalledOnce();
  });

  it("leaves Escape to a field and to what is open over the editor", () => {
    const { a } = editor({ range: { inMs: 0, outMs: 1000 } });
    expect(selectionKey(key("Escape"), place({ typing: true }), a)).toBe(false);
    expect(selectionKey(key("Escape"), place({ held: true }), a)).toBe(false);
    expect(a.setRange).not.toHaveBeenCalled();
  });
});
