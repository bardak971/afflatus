import { describe, expect, it } from "vitest";
import type { RecipeStatus } from "../src/api";
import { about, aboutMs, brief, clock, elapsed, fileLabel, left, long, notReady, pace, phaseLabel, problemSaid, recipeLabel, size, seconds, sourceOf, spell, took } from "../src/format";

describe("minutes and seconds", () => {
  it("rounds a length to the second", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(4600)).toBe("0:05");
    expect(clock(72_000)).toBe("1:12");
    expect(clock(3_600_000)).toBe("60:00");
  });
  it("floors a moment, so that a frame never reads as the next second", () => {
    expect(clock(4990, { decimals: 1 })).toBe("0:04.9");
    expect(clock(4990, { decimals: 2 })).toBe("0:04.99");
    expect(clock(3300, { decimals: 1 })).toBe("0:03.3");
    expect(clock(4200, { decimals: 2 })).toBe("0:04.20");
  });
  it("never goes below zero", () => {
    expect(clock(-500, { decimals: 1 })).toBe("0:00.0");
    expect(clock(-500)).toBe("0:00");
  });
  it("counts a running render to the second below", () => {
    expect(elapsed(59_999)).toBe("0:59");
    expect(elapsed(725_400)).toBe("12:05");
    expect(elapsed(-3)).toBe("0:00");
  });
});

describe("durations", () => {
  it("says a render's time in seconds, then minutes with padded seconds", () => {
    expect(took(42_400)).toBe("42 s");
    expect(took(59_499)).toBe("59 s");
    expect(took(185_000)).toBe("3 min 05 s");
  });
  it("says a long time in minutes, then hours", () => {
    expect(long(42_000)).toBe("42 s");
    expect(long(89_000)).toBe("1 min 29 s");
    expect(long(48 * 60_000)).toBe("48 min");
    expect(long((6 * 60 + 12) * 60_000)).toBe("6 h 12 min");
    expect(long(60 * 60_000)).toBe("1 h 00 min");
  });
  it("is short enough for a chart's scale", () => {
    expect(brief(42_000)).toBe("42s");
    expect(brief(185_000)).toBe("3m 05s");
    expect(brief(240_000)).toBe("4m");
    expect(brief(3_900_000)).toBe("1h 05m");
  });
  it("says seconds per step to two decimals under ten seconds, one above, and a dash when unknown", () => {
    expect(pace(1234)).toBe("1.23");
    expect(pace(12_345)).toBe("12.3");
    expect(pace(null)).toBe("—");
  });
  it("says what is left of a countdown, never less than a minute", () => {
    expect(left(0)).toBe("going to the bin");
    expect(left(-1, "over")).toBe("over");
    expect(left(10_000)).toBe("1 min left");
    expect(left(30 * 60_000)).toBe("30 min left");
    expect(left(5.4 * 3_600_000)).toBe("5 h left");
  });
  it("says an estimate as one, in steps of five seconds, never under five", () => {
    expect(aboutMs(null)).toBe("");
    expect(aboutMs(0)).toBe("");
    expect(aboutMs(1000)).toBe("about 5 s");
    expect(aboutMs(42_000)).toBe("about 40 s");
    expect(aboutMs(150_000)).toBe("about 3 min");
    expect(about(0)).toBe("");
    expect(about(42)).toBe("about 40 s left");
    expect(about(600)).toBe("about 10 min left");
  });
});

describe("names and sizes", () => {
  it("says a size on disk in the unit that fits", () => {
    expect(size(512)).toBe("1 KB");
    expect(size(340 * 2 ** 20)).toBe("340 MB");
    expect(size(38.24 * 2 ** 30)).toBe("38.2 GB");
  });
  it("names a model file without its folder or extension", () => {
    expect(fileLabel("checkpoints\\SDXL\\juggernaut_v9.safetensors")).toBe("juggernaut_v9");
    expect(fileLabel("wan/umt5.gguf")).toBe("umt5");
    expect(fileLabel("plain")).toBe("plain");
  });
  it("does not say the family twice", () => {
    expect(recipeLabel("Flux", "Flux picture")).toBe("Flux picture");
    expect(recipeLabel("Flux", "Picture")).toBe("Flux · Picture");
    expect(recipeLabel(undefined, "Picture")).toBe("Picture");
  });
  it("names a phase in ComfyUI's words, and passes an unknown one through", () => {
    expect(phaseLabel("decoding")).toBe("VAE decode");
    expect(phaseLabel("whatever")).toBe("whatever");
  });
  it("links the source of the release that runs, the repository for a build from the sources", () => {
    expect(sourceOf("v0.2.1")).toBe("https://github.com/bardak971/afflatus/tree/v0.2.1");
    expect(sourceOf("dev")).toBe("https://github.com/bardak971/afflatus");
    expect(sourceOf(undefined)).toBe("https://github.com/bardak971/afflatus");
  });
});

describe("why a recipe cannot run", () => {
  const status = (over: Partial<RecipeStatus>): RecipeStatus => ({ id: "r", ready: false, missingNodes: [], missingSlots: [], emptyInputs: [], missingFiles: [], ...over }) as RecipeStatus;
  it("says ComfyUI first, nothing for a ready recipe", () => {
    expect(notReady(status({}), false)).toBe("ComfyUI is not answering.");
    expect(notReady(status({ ready: true }), true)).toBeNull();
    expect(notReady(undefined, true)).toBeNull();
  });
  it("names the missing files and the first problem", () => {
    expect(notReady(status({ missingFiles: ["a.safetensors"] }), true)).toBe("ComfyUI does not have a.safetensors.");
    expect(notReady(status({ missingSlots: ["unet"] }), true)).toBe("A model file it needs was not found.");
    expect(notReady(status({ problems: ['49:43 KSampler: "beta57" is not a choice of "scheduler"'] }), true)).toBe('It asks for "beta57" as scheduler (KSampler), which your ComfyUI does not offer.');
    expect(problemSaid("odd")).toBe("ComfyUI would refuse it: odd.");
  });
});

describe("the clip tooltip's times", () => {
  it("says a length to a tenth and a measured time plainly", () => {
    expect(seconds(4500)).toBe("4.5 s");
    expect(spell(48_000)).toBe("48 s");
    expect(spell(130_000)).toBe("2 min 10 s");
    expect(spell(120_000)).toBe("2 min");
    expect(spell(3_900_000)).toBe("1 h 05 min");
  });
});
