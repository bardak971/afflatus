import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { RecipeInfo } from "../../src/api";
import { ShareFoot, sourceLead, type ClipSource } from "../../src/timeline/inspector/clipSource";
import { draw } from "./render";

const recipe = { id: "zz-test.swap", inputs: [{ id: "swapStrength", type: "number", label: "Swap LoRA strength" }] } as unknown as RecipeInfo;

function foot(over: Partial<ClipSource> = {}) {
  const asked: string[] = [];
  const s: ClipSource = {
    source: { pick: null } as never, count: 7, first: false, apart: [], takesPick: true, picking: false,
    onPicking: () => {}, onClearPick: () => {}, kept: false, windows: { leastMs: 3800, mostMs: 4900 }, onCut: () => {}, cutting: false, landed: null, lengths: [],
    mask: { status: "none", shown: false }, onShowMask: () => {}, onMaskShown: () => {}, list: [], onSelectWindow: () => {}, runUp: null, formAsk: null, cutAsk: null, stretchAsk: null, onUses: () => {}, trimming: false,
    onKept: (on) => asked.push(on ? "this clip" : "all"), onInLine: () => asked.push("in line"), onToAll: () => asked.push("to all"),
    ...over,
  };
  draw(<ShareFoot s={s} recipe={recipe} />);
  return asked;
}

describe("a clip made from the source, at its panel's foot (the owner, 2026-10-18)", () => {
  it("sends a change to every clip of the source unless kept to this one", () => {
    const asked = foot();
    expect(screen.getByRole("radio", { name: "All 7 clips" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "This clip" }));
    expect(asked).toEqual(["this clip"]);
    // nothing kept apart: nothing said of it
    expect(screen.queryByText(/Set apart/)).toBeNull();
  });

  it("says what a clip set apart keeps its own, by the settings' names, with the way back", () => {
    const asked = foot({ apart: ["swapStrength"] });
    expect(screen.getByText(/Set apart from the other 6 clips/)).toBeTruthy();
    expect(screen.getByText("Swap LoRA strength")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bring in line" }));
    fireEvent.click(screen.getByRole("button", { name: "Give it to all 7" }));
    expect(asked).toEqual(["in line", "to all"]);
  });
});

describe("a clip made from the source, its Source chapter (the rethink's source inspector)", () => {
  const swap = { id: "h3.swap", inputs: [{ id: "source", type: "clip", role: "source", window: { start: "sourceStart", seconds: "sourceSeconds" } }] } as unknown as RecipeInfo;
  const lead = (over: Partial<ClipSource>) => {
    const asked: string[] = [];
    const s = {
      source: { pick: null, fromMs: 0, toMs: 14000, windowMs: 5000, withinMs: 1500, video: { name: "dance.mp4", durationMs: 20000 } } as never, count: 3, first: true, apart: [], takesPick: false, picking: false,
      onPicking: () => {}, onClearPick: () => {}, kept: false, windows: { leastMs: 3800, mostMs: 5900 }, onCut: () => {}, cutting: false, landed: null, lengths: [],
      mask: { status: "none", shown: false }, onShowMask: () => {}, onMaskShown: () => {}, onKept: () => {}, onInLine: () => {}, onToAll: () => {},
      list: [
        { id: "a", number: 2, startMs: 0, seconds: 5.2, opens: true, form: "Swap character", carried: 0, own: false, rendered: true },
        { id: "b", number: 3, startMs: 5200, seconds: 4.4, opens: false, form: "Motion transfer", carried: 22, own: false, rendered: false },
        { id: "c", number: 4, startMs: 9600, seconds: 4.4, opens: true, form: "Swap character", carried: 0, own: true, rendered: false },
      ],
      onSelectWindow: (id: string) => asked.push(`select ${id}`),
      runUp: { counts: [5, 22, 39], value: 22, on: (n: number) => asked.push(`run-up ${n}`) },
      formAsk: null,
      cutAsk: null,
      stretchAsk: null,
      onUses: (from: number, to: number) => asked.push(`uses ${from}–${to}`),
      ...over,
    } as ClipSource;
    draw(<>{sourceLead(s, { inputs: { sourceStart: 5.2, sourceSeconds: 4.4 } }, swap).node}</>);
    return asked;
  };

  it("lists each window: its part, how it opens, its run-up, whose prompt; a click selects its clip", () => {
    const asked = lead({});
    expect(screen.getAllByText(/opens on the source/)).toHaveLength(2);
    expect(screen.getByText(/carries on · 22 · window 1's prompt/)).toBeTruthy();
    // each window's form (card #42: a swap where a shot opens, Motion transfer after it)
    expect(screen.getByText(/Motion transfer · carries on/)).toBeTruthy();
    expect(screen.getAllByText(/Swap character · opens on the source/)).toHaveLength(2);
    expect(screen.getByText(/its own prompt/)).toBeTruthy();
    fireEvent.click(screen.getByText(/carries on · 22/).closest("button")!);
    expect(asked).toEqual(["select b"]);
  });

  it("sets the run-up of every window in it", () => {
    const asked = lead({});
    fireEvent.click(screen.getByRole("radio", { name: "Long 39" }));
    expect(asked).toEqual(["run-up 39"]);
  });

  it("asks before a form on another grid drops rendered takes: Change or Keep it", () => {
    const asked: string[] = [];
    lead({ formAsk: { title: "Motion transfer", rendered: 1, windows: 3, change: () => asked.push("change"), keep: () => asked.push("keep") } });
    expect(screen.getByRole("alert").textContent).toMatch(/Motion transfer cuts the source on another grid.*3 windows are cut again; 1 rendered take go/);
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(asked).toEqual(["keep", "change"]);
  });

  it("asks before the source cut again drops rendered takes set aside past its end: Change or Keep it (card #114)", () => {
    const asked: string[] = [];
    lead({ cutAsk: { rendered: 2, change: () => asked.push("change"), keep: () => asked.push("keep") } });
    expect(screen.getByRole("alert").textContent).toMatch(/Cut again, the source drops what is set aside past its end.*2 rendered takes go to the library/);
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(asked).toEqual(["keep", "change"]);
  });
});

describe("a source's Clip length in its Source chapter, as a recording's (the owner, 2026-10-29)", () => {
  it("shows Clip length ± and what the ends landed on, and cuts again with both", () => {
    const cut: Array<{ windowMs?: number; withinMs?: number }> = [];
    const swap = { id: "h3.swap", inputs: [{ id: "source", type: "clip", role: "source", window: { start: "sourceStart", seconds: "sourceSeconds" } }] } as unknown as RecipeInfo;
    const s = {
      source: { pick: null, fromMs: 0, toMs: 14000, windowMs: 5000, withinMs: 1500, video: { name: "dance.mp4", durationMs: 20000 } } as never, count: 3, first: true, apart: [], takesPick: false, picking: false,
      onPicking: () => {}, onClearPick: () => {}, kept: false, windows: { leastMs: 3800, mostMs: 5900 }, onCut: (c: { windowMs?: number; withinMs?: number }) => cut.push(c), cutting: false,
      landed: "2 clips on a scene cut", lengths: [4.66, 5.3, 4.04],
      mask: { status: "none", shown: false }, onShowMask: () => {}, onMaskShown: () => {}, onKept: () => {}, onInLine: () => {}, onToAll: () => {},
      list: [], onSelectWindow: () => {}, runUp: null, formAsk: null, cutAsk: null, onUses: () => {}, trimming: false, stretchAsk: null,
    } as ClipSource;
    draw(<>{sourceLead(s, { inputs: { sourceStart: 0, sourceSeconds: 5 } }, swap).node}</>);
    expect(screen.getByText("2 clips on a scene cut · 4.7, 5.3, 4.0 s")).toBeTruthy();
    expect(screen.queryByText("Cut at scene changes")).toBeNull();
    const within = screen.getByLabelText("Window (± s of Clip length)") as HTMLInputElement;
    fireEvent.change(within, { target: { value: "0" } });
    fireEvent.blur(within);
    expect(cut).toEqual([{ windowMs: 5000, withinMs: 0 }]);
  });
});

describe("a source's stretch in its Source chapter (the rethink's trim, step 5)", () => {
  it("asks before a start moved after Make drops rendered takes: Change or Keep it", () => {
    const asked: string[] = [];
    const swap = { id: "h3.swap", inputs: [{ id: "source", type: "clip", role: "source", window: { start: "sourceStart", seconds: "sourceSeconds" } }] } as unknown as RecipeInfo;
    const s = {
      source: { pick: null, fromMs: 0, toMs: 14000, windowMs: 5000, withinMs: 1500, video: { name: "dance.mp4", durationMs: 20000 } } as never, count: 3, first: true, apart: [], takesPick: false, picking: false,
      onPicking: () => {}, onClearPick: () => {}, kept: false, windows: { leastMs: 3800, mostMs: 5900 }, onCut: () => {}, cutting: false, landed: null, lengths: [],
      mask: { status: "none", shown: false }, onShowMask: () => {}, onMaskShown: () => {}, onKept: () => {}, onInLine: () => {}, onToAll: () => {},
      list: [], onSelectWindow: () => {}, runUp: null, formAsk: null, cutAsk: null, onUses: () => {}, trimming: false,
      stretchAsk: { fromMs: 2000, rendered: 2, windows: 3, change: () => asked.push("change"), keep: () => asked.push("keep") },
    } as ClipSource;
    draw(<>{sourceLead(s, { inputs: { sourceStart: 0, sourceSeconds: 5 } }, swap).node}</>);
    expect(screen.getByRole("alert").textContent).toMatch(/starting at 0:02\.0 shifts every window.*3 windows are made anew; 2 rendered takes go/);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(asked).toEqual(["change"]);
  });

  it("says a trim of its stretch is under way, as the Recording chapter does (W-9)", () => {
    const swap = { id: "h3.swap", inputs: [{ id: "source", type: "clip", role: "source", window: { start: "sourceStart", seconds: "sourceSeconds" } }] } as unknown as RecipeInfo;
    const s = {
      source: { pick: null, fromMs: 0, toMs: 14000, windowMs: 5000, withinMs: 1500, video: { name: "dance.mp4", durationMs: 20000 } } as never, count: 3, first: true, apart: [], takesPick: false, picking: false,
      onPicking: () => {}, onClearPick: () => {}, kept: false, windows: { leastMs: 3800, mostMs: 5900 }, onCut: () => {}, cutting: false, landed: null, lengths: [],
      mask: { status: "none", shown: false }, onShowMask: () => {}, onMaskShown: () => {}, onKept: () => {}, onInLine: () => {}, onToAll: () => {},
      list: [], onSelectWindow: () => {}, runUp: null, formAsk: null, cutAsk: null, onUses: () => {}, trimming: true, stretchAsk: null,
    } as ClipSource;
    draw(<>{sourceLead(s, { inputs: { sourceStart: 0, sourceSeconds: 5 } }, swap).node}</>);
    expect(screen.getByText("Trimming the source…")).toBeTruthy();
  });
});
