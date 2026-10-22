import { describe, expect, it } from "vitest";
import type { RecipeInfo, RecipeStatus, Scan } from "../src/api";
import { listedOn } from "../src/loadChoices";
import { picksUnlisted } from "../src/officialFiles";

/**
 * Whether a machine has the model a form or a draft picks, as the Render on picker, the Load a model panel and the status
 * bar's "Model not here yet" ask it: matched as the server matches it when it builds the job (core sameFile), so that a
 * machine listing the same file behind a backslash or in a sub-folder of its own is not said to lack it.
 */

const recipe = { id: "zz-test.sdxl", family: "sdxl", inputs: [{ id: "ckpt", type: "model", label: "Model", folder: "checkpoints" }, { id: "prompt", type: "prompt", label: "Prompt" }] } as unknown as RecipeInfo;
const status = (options: Record<string, string[]>) => ({ id: recipe.id, ready: true, options }) as unknown as RecipeStatus;
const scan = (options: Record<string, string[]>) => ({ recipes: [status(options)] }) as unknown as Scan;

describe("a model in a machine's lists", () => {
  it("is found behind a backslash or in another sub-folder, as the render finds it", () => {
    expect(picksUnlisted(status({ ckpt: ["SDXL\\zz-test.safetensors"] }), recipe, { ckpt: "SDXL/zz-test.safetensors" })).toBe(false);
    expect(picksUnlisted(status({ ckpt: ["Mine\\Deep\\zz-test.safetensors"] }), recipe, { ckpt: "zz-test.safetensors" }, true)).toBe(false);
    expect(listedOn(scan({ ckpt: ["Other/zz-test.safetensors"] }), recipe.id, "ckpt", "SDXL\\zz-test.safetensors")).toBe(true);
  });

  it("is missing when no file of its name is listed", () => {
    expect(picksUnlisted(status({ ckpt: ["SDXL\\other.safetensors"] }), recipe, { ckpt: "SDXL/zz-test.safetensors" })).toBe(true);
    expect(listedOn(scan({ ckpt: ["other.safetensors"] }), recipe.id, "ckpt", "zz-test.safetensors")).toBe(false);
  });

  it("counts an input with no list as listed, unless asked otherwise, and a form that picks none as lacking nothing", () => {
    expect(picksUnlisted(status({}), recipe, { ckpt: "zz-test.safetensors" })).toBe(false);
    expect(picksUnlisted(status({}), recipe, { ckpt: "zz-test.safetensors" }, true)).toBe(true);
    expect(picksUnlisted(status({ ckpt: [] }), recipe, { ckpt: "" }, true)).toBe(false);
    expect(listedOn(scan({}), "zz-test.other", "ckpt", "zz-test.safetensors")).toBeNull();
  });
});
