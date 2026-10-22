import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { makeApp, post, referenceCatalog, type TestApp } from "./helpers";

/**
 * The prompt as sent a form shows, written from its parts (POST /api/form/prompt), is the one its render sends: a swap left
 * on its family's model is the file this ComfyUI has, and the fused reference turbo's own sentences come with it (review H-8).
 */

const FUSED = "minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors";

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: { diffusion_models: [FUSED], loras: ["h3_character_swap_v1.5.safetensors"] } });
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

describe("the prompt as sent, written from the parts", () => {
  it("is written for the swap model the form leaves on its family's file", async () => {
    const asked = (await post(t.app, "/api/form/prompt", { recipe: "h3.swap", input: { inSource: "the man", look: "", happens: "" } })).json();
    expect(asked.into).toBe("who");
    expect(asked.text).toMatch(/^Swap the man in <Video 1> with the character in <Picture 1>\. Keep the motion/);
  });

  it("is a window's that carries on, with the clip before the timeline gives it", async () => {
    // a Motion transfer window after a swap (card #42: Swap motion's that carried on)
    const asked = (await post(t.app, "/api/form/prompt", { recipe: "h3.motion", input: { afterSwap: true, look: "", happens: "he waves", previous: true } })).json();
    expect(asked.text).toBe("The person carries on moving as in the clip before. He waves.");
  });
});
