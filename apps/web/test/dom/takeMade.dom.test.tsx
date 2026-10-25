import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { Clip, ClipPatch, RecipeInfo, Take, TakeMade, Timeline } from "../../src/api";
import { ConfirmHost } from "../../src/Confirm";
import { useParts } from "../../src/recipeForm/Part";
import { Inspector } from "../../src/timeline/Inspector";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * A take says what it was made with, read from its own render (card #89): Timeline 10 showed a take of the girl under
 * Fabien's picture as the pinned first frame, the form's. The form stays the next render's settings: picking a take leaves
 * it as it is, and Use this take's settings puts a take's back, as one patch (one Undo step, the server's).
 */

const recipe = {
  id: "zz-test.video", family: "zz-test", title: "Video with audio", output: "video", summary: "", version: 1,
  inputs: [
    { id: "description", type: "prompt", label: "What happens" },
    { id: "start", type: "image", role: "start", label: "First frame", optional: true },
    { id: "references", type: "references", label: "References", max: 4, roles: ["person", "place"] },
    { id: "seed", type: "seed", label: "Seed", default: -1 },
  ],
  traits: { sound: true },
} as unknown as RecipeInfo;

const take = (id: string, made: TakeMade | null): Take =>
  ({ id, asset: { id: `a-${id}`, kind: "video", width: 576, height: 1024, durationMs: 5000 }, headMs: 0, tailMs: 0, trimStartMs: 0, trimEndMs: 0, startMs: 0, endMs: 5000, createdAt: "", finishedFrom: null, joinKind: null, roomMs: 5000, renderMs: null, measure: null, recipe: made?.recipe ?? null, made }) as unknown as Take;
const made = (form: Record<string, unknown>): TakeMade => ({ recipe: recipe.id, form, mirror: [] });

// take 1 was made with the form as it is; take 2, which plays, with the girl's picture as its first frame and her as its reference
const t1 = take("t1", made({ description: "zz-test: a person walks in", start: "pic-fabien", seed: 11 }));
const t2 = take("t2", made({ description: "zz-test: a person walks in", start: "pic-girl", references: [{ asset: "ref-girl", role: "person" }], seed: 22 }));

function inspector(stored: Record<string, unknown>, plays: Take = t2) {
  fakeApi.on("GET /recipes", { families: [], recipes: [recipe] });
  useParts.setState({ open: { inputs: true, takes: true } });
  const clip = { id: "c", kind: "video", recipe: recipe.id, joined: "cut", join: null, atMs: 0, lengthMs: 5000, inputs: stored, music: null, take: plays, takes: [t1, t2], sound: "own", volume: 100, pictures: [], pinMirror: [] } as unknown as Clip;
  const tl = { id: "zz-test-made", name: "zz-test made with", clips: [clip], durationMs: 5000, music: null, source: null, recordings: [] } as unknown as Timeline;
  const patches: ClipPatch[] = [];
  const inputs: Array<Record<string, unknown>> = [];
  const drawn = draw(
    <>
      <Inspector
        timeline={tl} clip={clip} index={0} recipes={[recipe]} stored={stored} whole={{ seed: -1, ...stored }} why={null}
        takesMs={null} takesOn={() => null} busy={false} error={null} onInputs={(next) => inputs.push(next)} onRecipe={() => {}} onPatch={(p) => patches.push(p)} onRender={() => {}}
        onMenu={() => {}} onRemoveTake={() => {}} onStop={() => {}} onPreview={() => {}} onDesigner={() => {}}
      />
      <ConfirmHost />
    </>,
  );
  return { ...drawn, patches, inputs };
}

const row = (n: number) => screen.getByRole("button", { name: n === 2 ? "Take 2, the one that plays" : `Play take ${n} instead` }).closest("div")!;

describe("a take shows what it was made with", () => {
  it("shows its own first frame and references, and how they differ from the form", async () => {
    inspector({ description: "zz-test: a person walks in", start: "pic-fabien" });
    const two = within(row(2));
    expect(two.getByAltText("first frame").getAttribute("src")).toBe("/api/assets/pic-girl/thumb");
    expect(two.getByAltText("reference: person").getAttribute("src")).toBe("/api/assets/ref-girl/thumb");
    expect(two.getByText("first frame and 1 reference differ")).toBeTruthy();
    expect(two.getByText("zz-test: a person walks in")).toBeTruthy();
    // take 1 was made with the form as it stands (the seed it drew is no difference: the form draws one): nothing said
    const one = within(row(1));
    expect(one.getByAltText("first frame").getAttribute("src")).toBe("/api/assets/pic-fabien/thumb");
    expect(one.queryByText(/differ/)).toBeNull();
    // the form's Inputs say the take that plays was not made with what they show
    expect(await screen.findByText("The take that plays was made with other inputs")).toBeTruthy();
  });

  it("says a prompt changed", () => {
    inspector({ description: "zz-test: a person runs out", start: "pic-girl", references: [{ asset: "ref-girl", role: "person" }] });
    expect(within(row(2)).getByText("prompt changed")).toBeTruthy();
    // take 1 opened on another picture too: both said, in one line
    expect(within(row(1)).getByText("first frame differs · prompt changed")).toBeTruthy();
  });

  it("says nothing in Inputs when the take that plays was made with the form", () => {
    inspector({ description: "zz-test: a person walks in", start: "pic-fabien" }, t1);
    expect(screen.queryByText("The take that plays was made with other inputs")).toBeNull();
  });
});

describe("Use this take's settings", () => {
  it("puts the take's form back as one patch, without a question when another take was made with the form", async () => {
    const { user, patches, inputs } = inspector({ description: "zz-test: a person walks in", start: "pic-fabien" });
    await user.click(await screen.findByRole("button", { name: "Use its settings" }));
    expect(patches).toEqual([{ recipe: recipe.id, inputs: { description: "zz-test: a person walks in", start: "pic-girl", references: [{ asset: "ref-girl", role: "person" }], seed: 22 }, pinMirror: { start: false }, settingsOf: "t2" }]);
    // through the patch alone: no form edit beside it, which would be an Undo step of its own
    expect(inputs).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks first when the form holds changes no take was made with", async () => {
    const { user, patches } = inspector({ description: "zz-test: a person waves", start: "pic-fabien" });
    await user.click(await screen.findByRole("button", { name: "Use its settings" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/changes no take was made with yet/);
    expect(patches).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Use its settings" }));
    await waitFor(() => expect(patches.map((p) => p.settingsOf)).toEqual(["t2"]));
  });

  it("is in a take's menu, when the take differs from the form", async () => {
    const { user, patches } = inspector({ description: "zz-test: a person walks in", start: "pic-fabien" });
    await user.click(screen.getByRole("button", { name: "Take 1: more" }));
    await screen.findByRole("menuitem", { name: /^Download/ });
    expect(screen.queryByRole("menuitem", { name: /^Use this take's settings/ })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Take 2: more" }));
    await user.click(await screen.findByRole("menuitem", { name: /^Use this take's settings/ }));
    expect(patches.map((p) => p.settingsOf)).toEqual(["t2"]);
  });
});

describe("browsing the takes", () => {
  it("leaves the form as it is: picking a take only says which plays", async () => {
    const { user, patches, inputs } = inspector({ description: "zz-test: a person walks in", start: "pic-fabien" });
    await user.click(screen.getByRole("button", { name: "Play take 1 instead" }));
    expect(patches).toEqual([{ take: "t1" }]);
    expect(inputs).toEqual([]);
  });
});
