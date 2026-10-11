import { describe, expect, it } from "vitest";
import { listOptions, unlistOptions } from "../src/setupLists";

describe("the setup's options, each list sent once", () => {
  const loras = Array.from({ length: 300 }, (_, i) => `zz-test lora ${i}.safetensors`);
  const scan: { at: string; recipes: Array<{ id: string; ready: boolean; options: Record<string, string[]> }> } = {
    at: "now",
    recipes: [
      { id: "a", ready: true, options: { loras, sampler: ["euler", "dpmpp_2m"] } },
      { id: "b", ready: false, options: { loras: [...loras], model: ["b.safetensors", "a.safetensors"] } },
      { id: "c", ready: true, options: { model: ["a.safetensors", "b.safetensors"] } },
    ],
  };

  it("sends a list the recipes share once, and lists in another order apart", () => {
    const sent = listOptions(scan);
    expect(sent.lists).toHaveLength(4);
    expect(sent.recipes[0]!.options.loras).toBe(sent.recipes[1]!.options.loras);
    expect(sent.recipes[1]!.options.model).not.toBe(sent.recipes[2]!.options.model);
    expect(JSON.stringify(sent).length).toBeLessThan(JSON.stringify(scan).length * 0.6);
  });

  it("is put back as it was", () => {
    expect(unlistOptions(JSON.parse(JSON.stringify(listOptions(scan))))).toEqual(scan);
  });
});
