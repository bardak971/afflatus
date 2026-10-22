import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { Clip, Take } from "../../src/api";
import { TakeList } from "../../src/timeline/inspector/takes";
import { draw } from "./render";

/** A clip's takes, each with how much its face is its person's (Face Match), the closest one marked (card #18). */
const take = (id: string, face?: number): Take =>
  ({ id, asset: { id: `a-${id}`, kind: "video", width: 576, height: 1024, durationMs: 5000 }, headMs: 0, tailMs: 0, trimStartMs: 0, trimEndMs: 0, startMs: 0, endMs: 5000, createdAt: "", finishedFrom: null, joinKind: null, roomMs: 5000, renderMs: null, measure: face != null ? { luma: 100, sharp: 10, face } : null, recipe: null }) as unknown as Take;

function list(takes: Take[], { onFacePass, plays = takes[0]!, joins = {} }: { onFacePass?: (t: Take) => void; plays?: Take; joins?: Record<string, { in: number | null; out: number | null }> } = {}) {
  const clip = { id: "c", kind: "video", takes, take: plays } as unknown as Clip;
  draw(<TakeList clip={clip} take={plays} joinOf={(id) => joins[id]} smoothest={null} onPreview={() => {}} onPatch={() => {}} onRemoveTake={() => {}} onFacePass={onFacePass} />);
}
/** The rows' titles, top to bottom. */
const order = () => screen.getAllByText(/^Take \d+$/).map((e) => e.textContent);

describe("the takes of a clip, with their face figure", () => {
  it("says each take's face and marks the closest", () => {
    list([take("1", 0.52), take("2", 0.71), take("3", 0.48)]);
    expect(screen.getByText(/face 0\.71/)).toBeTruthy();
    expect(screen.getByText(/face 0\.48/)).toBeTruthy();
    const marked = screen.getByText("closest face");
    expect(marked.closest("div")!.textContent).toMatch(/Take 2/);
  });

  it("marks none with a single take measured, says nothing for a take not measured", () => {
    list([take("1", 0.6), take("2")]);
    expect(screen.getByText(/face 0\.60/)).toBeTruthy();
    expect(screen.queryByText("closest face")).toBeNull();
  });

  it("sorts the closest face first, each take keeping its number", () => {
    list([take("1", 0.52), take("2", 0.71), take("3", 0.48)]);
    fireEvent.click(screen.getByRole("radio", { name: "Closest face" }));
    expect(order()).toEqual(["Take 1", "Take 2", "Take 3"]);
  });
});

describe("the take that plays comes first (review 4, P8)", () => {
  it("leads the list, then the newest", () => {
    const takes = Array.from({ length: 11 }, (_, i) => take(String(i + 1)));
    list(takes, { plays: takes[10]! });
    expect(order()).toEqual(["Take 11", "Take 10", "Take 9", "Take 8", "Take 7", "Take 6", "Take 5", "Take 4", "Take 3", "Take 2", "Take 1"]);
    list([take("1"), take("2"), take("3")], { plays: take("2") });
    expect(order().slice(11)).toEqual(["Take 2", "Take 3", "Take 1"]);
  });

  it("leads the smoothest sort too, the others by their worst join", () => {
    const takes = [take("1"), take("2"), take("3"), take("4")];
    list(takes, { plays: takes[3]!, joins: { "1": { in: 2, out: 20 }, "2": { in: 1.1, out: 0.6 }, "3": { in: null, out: 4 } } });
    fireEvent.click(screen.getByRole("radio", { name: "Smoothest" }));
    expect(order()).toEqual(["Take 4", "Take 2", "Take 3", "Take 1"]);
  });

  it("offers no sort for takes it cannot tell apart", () => {
    list([take("1"), take("2")]);
    expect(screen.queryByRole("radiogroup", { name: "Sort the takes" })).toBeNull();
  });
});

describe("a take's menu", () => {
  it("offers Face refine, and the library's actions on its video", async () => {
    const asked: string[] = [];
    list([take("1", 0.5), take("2", 0.6)], { onFacePass: (t) => asked.push(t.id) });
    fireEvent.click(screen.getByRole("button", { name: "Take 2: more" }));
    for (const name of ["Play this take", "Download", "Keep", "Compare", "Remove take 2"]) expect(await screen.findByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeTruthy();
    // the take's own Remove takes its video to the bin with it: the library's bin is not offered beside it
    expect(screen.queryByRole("menuitem", { name: /^Move to the bin/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Face refine/ }));
    expect(asked).toEqual(["2"]);
  });

  it("says a Face refine take for what it is, and offers none of a Face refine", async () => {
    const pass = { ...take("2", 0.7), finishedFrom: "1", facePass: true } as Take;
    list([take("1", 0.5), pass], { onFacePass: () => {} });
    expect(screen.getByText("face refine of take 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take 2: more" }));
    expect(await screen.findByRole("menuitem", { name: /^Download/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /^Face refine/ })).toBeNull();
  });

  it("offers no Face refine where the model has none", async () => {
    list([take("1", 0.5)]);
    fireEvent.click(screen.getByRole("button", { name: "Take 1: more" }));
    expect(await screen.findByRole("menuitem", { name: /^Download/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /^Face refine/ })).toBeNull();
  });
});
