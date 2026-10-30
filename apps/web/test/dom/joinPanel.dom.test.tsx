import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { Clip, ClipPatch, RecipeInfo, Take } from "../../src/api";
import { JoinPanel } from "../../src/timeline/inspector/join";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** Two H3 clips, the second carrying on from the first in the latent (card #174's mock: version 2, its six states). */
const h3 = { id: "h3.video", title: "Video", family: "h3", inputs: [], traits: { continues: "clip", latentNodes: ["x"] } } as unknown as RecipeInfo;
const take = (over: Partial<Take> = {}): Take =>
  ({ id: "t1", asset: { id: "a1", kind: "video", width: 576, height: 1024, durationMs: 5900 }, headMs: 917, tailMs: 0, trimStartMs: 0, trimEndMs: 0, startMs: 917, endMs: 5900, createdAt: "", finishedFrom: null, joinKind: "seamless", seamless: true, roomMs: 5000, renderMs: null, measure: { luma: 100, sharp: 10, handover: 1 }, recipe: "h3.video", made: null, ...over }) as unknown as Take;
const before = { id: "c1", kind: "video", recipe: "h3.video", joined: "cut", join: null, transition: null, take: take({ id: "t0", joinKind: null, headMs: 0 }), takes: [], lengthMs: 5200 } as unknown as Clip;

async function panel(over: Partial<Clip>, { jump = 0.6, retake = true }: { jump?: number | null; retake?: boolean } = {}) {
  const t = over.take === undefined ? take() : over.take;
  const clip = { id: "c2", kind: "video", recipe: "h3.video", joined: "continue", join: t ? "fresh" : null, transition: null, takes: t ? [t] : [], lengthMs: 5000, ...over, take: t } as unknown as Clip;
  if (t) fakeApi.on("POST /measures/joins", { items: { c2: [{ take: t.id, in: jump, out: null }] } });
  const patches: ClipPatch[] = [];
  const asked: string[] = [];
  draw(<JoinPanel clip={clip} index={1} before={before} recipes={[h3]} onPatch={(p) => patches.push(p)} retake={retake ? { run: () => asked.push("retake"), why: null } : undefined} onClose={() => {}} onSelectClip={() => {}} />);
  // a seamless join with a take asks for its figures (batched, a moment later): answered before the test ends, not after
  if (t && clip.joined === "continue") await waitFor(() => expect(fakeApi.calls("POST", "/measures/joins")).toHaveLength(1));
  return { patches, asked };
}
const card = (name: RegExp) => screen.getByRole("radio", { name });

describe("the join panel's two cards say what a switch does to the take, before the click (card #174)", () => {
  it("seamless that holds: its figures with their units; Hard cut says it keeps the take, no render", async () => {
    const { patches } = await panel({});
    expect(card(/^Seamless/).getAttribute("aria-checked")).toBe("true");
    expect(await screen.findByText("take 1 holds · join ×0.6")).toBeTruthy();
    expect(screen.getByText("jump ÷ the clip's own motion")).toBeTruthy();
    expect(screen.getByText("carries on")).toBeTruthy();
    const cut = card(/^Hard cut/);
    expect(cut.textContent).toContain("take 1 kept · plays from its own first frame");
    expect(cut.dataset.tip).toBe("Take 1 stays. It plays from its own first frame, after the run-up, as a plain cut: no render. Its first frames still carry clip 1's motion on. Back to seamless: as it was, no render.");
    // the transitions wait for a hard cut, said in their own heading, the first tile None (not "Cut")
    expect(screen.getByText("· needs a hard cut")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^None/ })).toBeTruthy();
    fireEvent.click(cut);
    expect(patches).toEqual([{ joined: "cut" }]);
  });

  it("a cut at the join: amber, said, with a new take or a hard cut onto the new shot (trimmed to it, no render)", async () => {
    const { patches, asked } = await panel({ take: take({ measure: { luma: 100, sharp: 10, handover: 1, runUpCut: { atMs: 420, db: 10.2 } } }) });
    expect(card(/^Seamless/).textContent).toContain("cut at the join · 0.42 s in");
    expect(screen.getByText(/Take 1 cuts to another shot 0\.42 s after its run-up/)).toBeTruthy();
    expect(screen.getByText("then a cut, 0.42 s in")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New take" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it as a hard cut" }));
    expect(asked).toEqual(["retake"]);
    expect(patches).toEqual([{ joined: "cut", trimStartMs: 420 }]);
  });

  it("a hard cut by choice: the take made seamless plays from its own first frame; back to seamless needs no render while it follows", async () => {
    const { patches } = await panel({ joined: "cut", join: "cut", joinIfSeamless: "fresh" });
    expect(card(/^Hard cut/).getAttribute("aria-checked")).toBe("true");
    expect(card(/^Hard cut/).textContent).toContain("take 1 plays from its own first frame");
    expect(card(/^Seamless/).textContent).toContain("back to seamless: no render");
    expect(screen.getByText(/Take 1 was made seamless: it plays from its own first frame, as a hard cut/)).toBeTruthy();
    expect(screen.queryByText("· needs a hard cut")).toBeNull();
    fireEvent.click(card(/^Seamless/));
    expect(patches).toEqual([{ joined: "continue" }]);
  });

  it("a take made as a hard cut: back to seamless says it needs a new take", async () => {
    await panel({ joined: "cut", join: "cut", joinIfSeamless: "stale", take: take({ joinKind: null, seamless: false, headMs: 0 }) });
    expect(card(/^Seamless/).textContent).toContain("back to seamless: a new take");
    expect(card(/^Seamless/).dataset.tip).toBe("Take 1 was made as a hard cut: seamless needs a new take of clip 2, carrying on from clip 1.");
    expect(screen.queryByText(/was made seamless/)).toBeNull();
  });

  it("with a transition: its tile, length and audio, the None tile off", async () => {
    await panel({ joined: "cut", join: "cut", joinIfSeamless: "fresh", transition: { kind: "dissolve", ms: 500, sound: "on" } });
    expect(screen.getByRole("button", { name: /Cross dissolve/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^None/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Length")).toBeTruthy();
  });

  it("not rendered yet: what clip 2 will be made from", async () => {
    await panel({ take: null });
    expect(card(/^Seamless/).textContent).toContain("not rendered yet");
    expect(card(/^Hard cut/).textContent).toContain("clip 2 starts from its own first frame");
    expect(screen.getByText("Clip 2 will carry on from clip 1's last frames, decoded with them.")).toBeTruthy();
  });
});
