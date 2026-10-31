import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeRecipe } from "@afflatus/core";
import { recipeById } from "@afflatus/recipes";
import type { RecipeInfo } from "../../src/api";
import { Form } from "../../src/RecipeForm";
import { layoutOf } from "../../src/form";
import { useParts } from "../../src/recipeForm/Part";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Card #170: the four H3 forms on one skeleton (the owner's "every H3 form alike"). The same six tabs on each, the job's own
 * card (Mask, Motion) and Sound reached under Inputs, What happens heading the Prompt card, the sound rows together.
 */
const info = (id: string) => describeRecipe(recipeById(id)!) as unknown as RecipeInfo;
const FORMS = ["h3.video", "h3.lipsync", "h3.swap", "h3.motion"];
const TABS = ["Model", "Prompt", "Inputs", "Sampling", "Output", "Advanced"];

/** The strip's tabs, by their words (the search's button aside). */
const tabs = () => [...document.querySelectorAll<HTMLButtonElement>(".sticky button")].filter((b) => !b.getAttribute("aria-label")).map((b) => b.textContent);
/** The form's cards, in the order they are drawn. */
const cards = () => [...document.querySelectorAll<HTMLElement>("[data-part]")].map((e) => e.dataset.part!).filter((id) => !id.includes(":"));

describe("the four H3 forms on one skeleton", () => {
  beforeEach(() => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
    useParts.setState({ open: {} });
    fakeApi.on("GET /settings", { machines: [], pinnedFields: {} });
    fakeApi.on("POST /form/prompt", { into: null, text: "" });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(FORMS)("%s: the same six tabs, its own card and Sound drawn after Inputs", (id) => {
    const drawn = draw(<Form recipe={info(id)} status={undefined} stored={{}} onChange={() => {}} onClear={() => {}} />);
    expect(tabs()).toEqual(TABS);
    const own = id === "h3.swap" ? ["mask"] : id === "h3.motion" ? ["motion"] : [];
    // the Sound card holds the sound settings alone (card #210): with nothing to hear yet, Video with audio and Lip sync have
    // none; Swap and Motion transfer show Keep the source's sound
    const sound = id === "h3.swap" || id === "h3.motion" ? ["sound"] : [];
    expect(cards()).toEqual(["model", "prompt", "inputs", ...own, ...sound, "sampling", "output", "advanced"]);
    drawn.unmount();
  });

  it.each(FORMS)("%s: What happens is the main box, Sound effects and Music under it, the sound settings in Sound", (id) => {
    const recipe = info(id);
    const l = layoutOf(recipe, { keepSound: false, voice: "v", recording: "r" }, "");
    expect(l.mainText?.label).toBe("What happens");
    // H3's prompt text in the Prompt card, first under What happens (card #210); a swap takes none
    expect(l.texts.map((i) => i.label).slice(0, 2)).toEqual(id === "h3.swap" ? ["How they look", "In the source"] : ["Sound effects", "Music"]);
    const sound = l.chapters.find((ch) => ch.id === "sound")!.items.map((i) => i.label);
    const want = {
      "h3.video": ["Normalize loudness"],
      "h3.lipsync": ["Speech starts at", "Normalize loudness"],
      "h3.swap": ["Keep the source's sound"],
      "h3.motion": ["Keep the source's sound"],
    }[id];
    expect(sound).toEqual(want);
    // nothing of the sound left in Sampling
    expect(l.sampling.map((i) => i.id).filter((i) => ["keepSound", "soundGuide", "speechAt", "evenLoudness", "voiceEven"].includes(i))).toEqual([]);
  });

  it("Swap's Resolution with what comes out, Veda's sparsity and the step cache's numbers under their switches in Sampling", () => {
    const ids = (list: Array<{ id: string }>) => list.map((i) => i.id);
    const swap = layoutOf(info("h3.swap"), { veda: true, cache: true, fast: false }, "");
    expect(ids(swap.out)).toContain("swapSize");
    expect(ids(swap.knobs)).not.toContain("swapSize");
    expect(ids(swap.knobs)).not.toContain("denoise");
    const sampling = ids(swap.sampling);
    expect(sampling.slice(sampling.indexOf("cache"), sampling.indexOf("cache") + 5)).toEqual(["cache", "cacheThreshold", "cacheStart", "cacheEnd", "cacheSteps"]);
    expect(sampling.slice(sampling.indexOf("veda"), sampling.indexOf("veda") + 3)).toEqual(["veda", "vedaGenerated", "vedaReference"]);
    expect(sampling).toContain("denoise");
    expect(ids(swap.rare)).toContain("turboIn");
    expect(ids(swap.rare)).not.toContain("hybrid");
  });

  it("a model filed under Output is drawn there alone: SeedVR2's and Face refine's were drawn in Model too", () => {
    const l = layoutOf(info("h3.video"), { upscale: "Video: SeedVR2 (restores)", faceRefine: true }, "");
    const ids = (list: Array<{ id: string }>) => list.map((i) => i.id);
    expect(ids(l.knobs)).not.toContain("faceRefineModel");
    expect(ids(l.knobs)).not.toContain("seedvrModel");
    expect(ids(l.out)).toContain("faceRefineModel");
  });

  it("Keyframe at under its Keyframe, Landing under its Next clip", () => {
    const l = layoutOf(info("h3.video"), { mid: "m", next: { asset: "n" } }, "");
    const frames = l.frames.map((i) => i.id);
    expect(frames[frames.indexOf("mid") + 1]).toBe("midAt");
    expect(frames[frames.indexOf("next") + 1]).toBe("landing");
  });
});
