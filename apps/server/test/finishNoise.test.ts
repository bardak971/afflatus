import { describe, expect, it } from "vitest";
import { finishNow, settingsSchema } from "../src/settings";

/**
 * The Finish dialog's H3 re-sample denoise is the σ it starts at since card #141. One saved before was BasicScheduler's at
 * the clip's shift, under another key: read as the σ it started at (at the H3 forms' shift 11), the pair it started on as
 * the new defaults.
 */
const finish = (saved: Record<string, unknown>) => settingsSchema.parse({ finish: finishNow(saved) }).finish;

describe("the Finish settings' re-sample denoise", () => {
  it("starts on σ 0.25 in 3 steps", () => {
    expect(finish({})).toMatchObject({ latentNoise: 0.25, latentSteps: 3 });
  });
  it("reads an older denoise as the σ it started at, its steps kept", () => {
    expect(finish({ route: "latent", latentDenoise: 0.2, latentSteps: 2 })).toMatchObject({ route: "latent", latentNoise: 0.73, latentSteps: 2 });
    expect(finish({ latentDenoise: 0.1, latentSteps: 3 })).toMatchObject({ latentNoise: 0.55, latentSteps: 3 });
    expect(finish({ latentDenoise: 0.2 })).not.toHaveProperty("latentDenoise");
  });
  it("reads the pair it started on (0.15, 2 steps) as the new defaults", () => {
    expect(finish({ latentDenoise: 0.15, latentSteps: 2 })).toMatchObject({ latentNoise: 0.25, latentSteps: 3 });
    expect(finish({ latentDenoise: 0.15 })).toMatchObject({ latentNoise: 0.25, latentSteps: 3 });
  });
  it("keeps one saved under the new key", () => {
    expect(finish({ latentDenoise: 0.3, latentNoise: 0.2, latentSteps: 2 })).toMatchObject({ latentNoise: 0.2, latentSteps: 2 });
  });
});
