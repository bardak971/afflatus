import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { describeRecipe } from "@afflatus/core";
import { recipeById } from "@afflatus/recipes";
import type { RecipeInfo } from "../../src/api";
import { Form } from "../../src/RecipeForm";
import { useParts } from "../../src/recipeForm/Part";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Card #49 (the owner's Timeline 23 clip 1): Swap character with its parts typed showed the fused turbo's preset in "Prompt as
 * sent", in the colour of a typed prompt, while the render sent what the parts write. A text the form starts on is read as
 * empty by the form as by the render: the parts' prompt shows there greyed, on every H3 form written from parts.
 */

const REFDELTA = "minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors";
const WRITTEN = "Swap teest in <Video 1> with the character in <Picture 1>. The character in <Picture 1>: test. Test. Keep the motion, the gestures and the lip movements of <Video 1>. Keep the room of <Video 1> exactly as it is.";
const info = (id: string) => describeRecipe(recipeById(id)!) as unknown as RecipeInfo;
/** The texts a swap starts on (the LoRA's caption, the fused turbo's old preset), as the server describes the recipe. */
const STARTED_ON = info("h3.swap").partsStartOn ?? [];
/** "Prompt as sent": the text of its own part (text:who on a swap, text:description on Motion transfer). */
const sentField = () => {
  const field = document.querySelector<HTMLTextAreaElement>('[data-part="text:who"] textarea, [data-part="text:description"] textarea');
  if (!field) throw new Error("no Prompt as sent drawn");
  return field;
};

describe("the prompt as sent, when the form holds a text it started on", () => {
  beforeEach(() => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
    useParts.setState({ open: { prompt: true, "text:who": true, "text:description": true } });
    fakeApi.on("GET /settings", { machines: [], pinnedFields: {} });
  });
  afterEach(() => vi.restoreAllMocks());

  const parts = { swapModel: REFDELTA, inSource: "teest", look: "test", happens: "test" };

  it("Swap character on the fused turbo: the parts' prompt greyed, not the turbo's preset as if typed", async () => {
    fakeApi.on("POST /form/prompt", { into: "who", text: WRITTEN });
    draw(<Form recipe={info("h3.swap")} status={undefined} stored={parts} onChange={() => {}} onClear={() => {}} />);
    await waitFor(() => expect(sentField().placeholder).toBe(WRITTEN));
    expect(sentField().value).toBe("");
  });

  it("Swap character from a draft or clip that saved a starting text: read as empty, as the render reads it", async () => {
    fakeApi.on("POST /form/prompt", { into: "who", text: WRITTEN });
    expect(STARTED_ON).toHaveLength(2);
    for (const started of STARTED_ON) {
      const drawn = draw(<Form recipe={info("h3.swap")} status={undefined} stored={{ ...parts, who: started }} onChange={() => {}} onClear={() => {}} />);
      await waitFor(() => expect(sentField().placeholder).toBe(WRITTEN));
      expect(sentField().value).toBe("");
      drawn.unmount();
    }
  });

  it("Swap character: a prompt typed is shown as typed", async () => {
    fakeApi.on("POST /form/prompt", { into: "who", text: WRITTEN });
    const typed = `${STARTED_ON[0]} zz-test typed.`;
    draw(<Form recipe={info("h3.swap")} status={undefined} stored={{ ...parts, who: typed }} onChange={() => {}} onClear={() => {}} />);
    await waitFor(() => expect(sentField().placeholder).toBe(WRITTEN));
    expect(sentField().value).toBe(typed);
  });

  it("Motion transfer: the parts' prompt greyed while the prompt as sent is empty", async () => {
    const written = "The person: test. Test.";
    fakeApi.on("POST /form/prompt", { into: "description", text: written });
    draw(<Form recipe={info("h3.motion")} status={undefined} stored={{ look: "test", happens: "test" }} onChange={() => {}} onClear={() => {}} />);
    await waitFor(() => expect(sentField().placeholder).toBe(written));
    expect(sentField().value).toBe("");
  });
});
