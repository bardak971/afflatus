import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { addedRows, type InputSpec, type LoraValue } from "@afflatus/core";
import { Loras, type AddedLoras } from "../../src/fields/Loras";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Card #160: a LoRA the recipe adds itself is a row of the LoRA list, first, with its file and its weight. Its × turns Turbo
 * off; a row the model needs has none. The same file added by hand is shown as that row, and moved into it at the first change.
 */
const TURBO = "zz-test-h3-turbo.safetensors";
const OTHER = "zz-test-style.safetensors";
const list: Extract<InputSpec, { type: "loras" }> = {
  id: "loras", type: "loras", label: "LoRAs", max: 6,
  added: [{ label: "Turbo", note: "Turbo's LoRA", toggle: "fast", file: "turboLora", weight: "turboWeight", slots: [{ slot: "turbo" }] }],
};
const needed: Extract<InputSpec, { type: "loras" }> = {
  id: "loras", type: "loras", label: "LoRAs", max: 6,
  added: [{ label: "Needed by this model", note: "the distilled LoRA", file: "distilledLora", weight: "loraStrength", slots: [{ slot: "turbo" }] }],
};
const specs: InputSpec[] = [
  { id: "fast", type: "toggle", label: "Turbo", default: false },
  { id: "turboLora", type: "model", label: "Turbo LoRA", folder: "loras", slot: "turbo", blank: true, inList: "loras" },
  { id: "turboWeight", type: "number", label: "Turbo LoRA weight", min: -4, max: 4, step: 0.05, default: 1, inList: "loras" },
  { id: "distilledLora", type: "model", label: "Distilled LoRA", folder: "loras", slot: "turbo", blank: true, inList: "loras" },
  { id: "loraStrength", type: "number", label: "Distilled LoRA strength", min: 0, max: 1.5, step: 0.05, default: 0.5, inList: "loras" },
];

function serve() {
  fakeApi.on("GET /settings", { machines: [], hasRunpodKey: false });
  fakeApi.on("GET /setup", { comfy: { online: true }, recipes: [], lists: [], places: { on: {}, offered: {}, down: {} } });
  fakeApi.on("GET /official-sizes", { sizes: {}, asking: false });
  fakeApi.on("GET /models/:folder/info", { items: {}, pending: 0 });
  fakeApi.on("GET /models/updates", { items: [] });
  fakeApi.on("GET /model-words", { items: {} });
}

function drawList(spec: Extract<InputSpec, { type: "loras" }>, values: Record<string, unknown>, over: InputSpec[] = specs) {
  serve();
  const set = vi.fn();
  const onChange = vi.fn();
  const added: AddedLoras = { rows: addedRows(spec, values, { turbo: TURBO }), specs: over, options: { turboLora: [TURBO, OTHER], distilledLora: [TURBO] }, values, set };
  const value = (values.loras as LoraValue[] | undefined) ?? [];
  const drawn = draw(<Loras spec={spec} value={value} options={[TURBO, OTHER]} family={undefined} model={undefined} onChange={onChange} added={added} />);
  return { ...drawn, set, onChange };
}

describe("the LoRAs the recipe adds itself, in the LoRA list", () => {
  it("draws Turbo's row first with its file and weight; its × turns Turbo off", async () => {
    const { user, set } = drawList(list, { fast: true, loras: [] });
    const row = document.querySelector<HTMLElement>('[data-added="Turbo"]')!;
    expect(within(row).getByText("Turbo")).toBeTruthy();
    expect(within(row).getByRole("button", { name: /^Turbo LoRA:/ }).textContent).toContain("zz-test-h3-turbo");
    expect((within(row).getByRole("textbox", { name: /typed/ }) as HTMLInputElement).value).toBe("1.00");
    // the list's count is of every LoRA the render loads: Turbo's row among them
    expect(screen.getByText("1 of 6")).toBeTruthy();
    await user.click(within(row).getByRole("button", { name: /turns Turbo off/ }));
    expect(set).toHaveBeenCalledWith("fast", false);
  });

  it("has no row with Turbo off", () => {
    drawList(list, { fast: false, loras: [] });
    expect(document.querySelector('[data-added="Turbo"]')).toBeNull();
  });

  it("shows the same file added by hand as Turbo's row, and moves its weight into the row at the first change", async () => {
    const { user, set, onChange } = drawList(list, { fast: true, loras: [{ file: TURBO, weight: 0.8 }, { file: OTHER, weight: 0.5 }] });
    // one row of the file: Turbo's, at the hand weight; the other LoRA as it was
    expect(document.querySelectorAll('[data-added="Turbo"]')).toHaveLength(1);
    const row = document.querySelector<HTMLElement>('[data-added="Turbo"]')!;
    expect((within(row).getByRole("textbox", { name: /typed/ }) as HTMLInputElement).value).toBe("0.80");
    expect(screen.getByText("2 of 6")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: `Remove ${"zz-test-h3-turbo"}` })).toHaveLength(0);
    const box = within(row).getByRole("textbox", { name: /typed/ });
    await user.clear(box);
    await user.type(box, "0.6{Enter}");
    expect(onChange).toHaveBeenCalledWith([{ file: OTHER, weight: 0.5 }]);
    expect(set).toHaveBeenLastCalledWith("turboWeight", 0.6);
  });

  it("folds a hand weight into the row within the row's own range (card #189)", async () => {
    // Wan's high-noise turbo strength goes to 1.2: a hand row at 3 of its file, folded in, was a render refused
    const narrow = specs.map((x) => (x.id === "turboWeight" ? { ...x, min: 0, max: 1.2 } : x));
    const { user, set, onChange } = drawList(list, { fast: true, loras: [{ file: TURBO, weight: 3 }] }, narrow);
    await user.click(within(document.querySelector<HTMLElement>('[data-added="Turbo"]')!).getByRole("button", { name: /turns Turbo off/ }));
    expect(onChange).toHaveBeenCalledWith([]);
    expect(set).toHaveBeenCalledWith("turboWeight", 1.2);
    expect(set).toHaveBeenLastCalledWith("fast", false);
  });

  it("counts Turbo's row among the list's places: five of your own with it on", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ file: `zz-test-${i}.safetensors`, weight: 0.5 }));
    drawList(list, { fast: true, loras: five });
    expect(screen.getByText("6 of 6")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /add one/ })).toBeNull();
    expect(screen.queryByText("Add a LoRA")).toBeNull();
  });

  it("draws a LoRA the model needs without a ×, and says when it is not loaded", () => {
    drawList(needed, { loraStrength: 0, loras: [] });
    const row = document.querySelector<HTMLElement>('[data-added="Needed by this model"]')!;
    expect(row).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(within(row).getByText(/not loaded/)).toBeTruthy();
  });
});
