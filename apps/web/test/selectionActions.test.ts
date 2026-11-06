import { describe, expect, it, vi } from "vitest";
import type { AssetDetail, RecipeInfo } from "../src/api";
import { ACTIONS, selectionActions, type SelectionFacts } from "../src/itemActions";
import { passJob, type PassPlace } from "../src/selectionPasses";
import { NO_HAND_DETECTOR } from "../src/viewer/shared";

/** What a library selection does together (itemActions' selectionActions), and the job each picture's pass is (selectionPasses.ts). */

const facts = (more: Partial<SelectionFacts> = {}): SelectionFacts => ({ count: 3, pictures: 3, seen: 3, inBin: false, passes: { upscale: "Upscale", face: "Face", hand: "Face", background: "Cut out" }, ...more });

describe("a library selection's actions", () => {
  it("are a zip, each quick pass on every picture, and Compare, on for exactly two", () => {
    const pass = vi.fn();
    const list = selectionActions(facts(), { zip: () => {}, pass, compare: () => {} });
    expect(list.map((x) => x.label)).toEqual(["Download zip", "Vary subtle", "Vary strong", "Upscale 2x", "Face refine", "Hand refine", "Remove background", "Compare"]);
    expect(list.find((x) => x.id === "upscale")!.note).toBe("on 3 pictures");
    // the pass's own icon and group: the same action as an item's, said for many
    expect(list.find((x) => x.id === "face")!.icon).toBe(ACTIONS.face.icon);
    list.find((x) => x.id === "hand")!.run!();
    expect(pass).toHaveBeenCalledWith("hand");
    const two = selectionActions(facts({ count: 2, pictures: 1, seen: 2 }), { zip: () => {}, pass, compare: () => {} });
    expect(two.at(-1)!.label).toBe("Compare");
    expect(two.find((x) => x.id === "upscale")!.note).toBe("on 1 picture");
  });

  it("say why a pass is off, leave the passes out without pictures or in the bin, and grey Compare with why past two", () => {
    const list = selectionActions(facts({ passes: { upscale: "Upscale" } }), { zip: () => {}, pass: () => {} });
    expect(list.find((x) => x.id === "face")).toMatchObject({ disabled: true, note: "no model for it", run: undefined });
    expect(list.find((x) => x.id === "upscale")!.disabled).toBe(false);
    // a pass running: none can be asked again meanwhile
    expect(selectionActions(facts(), { zip: () => {} }).filter((x) => x.group === "passes").every((x) => x.disabled)).toBe(true);
    expect(selectionActions(facts({ pictures: 0, seen: 2, count: 2 }), { zip: () => {}, compare: () => {} }).map((x) => x.id)).toEqual(["download", "compare"]);
    expect(selectionActions(facts({ inBin: true }), { zip: () => {}, pass: () => {} }).map((x) => x.id)).toEqual(["download", "compare"]);
    // card #318: Compare came and went as a third was ticked, the bar's buttons jumping; it stays now, greyed with why
    const three = selectionActions(facts(), { compare: () => {} }).find((x) => x.id === "compare")!;
    expect(three).toMatchObject({ disabled: true, run: undefined });
    expect(three.tip).toBe("Tick exactly two pictures or videos to compare them");
    // two sounds and a picture: three ticked, nothing to compare
    expect(selectionActions(facts({ count: 3, seen: 2 }), { compare: () => {} }).find((x) => x.id === "compare")!.disabled).toBe(true);
  });
});

const source = { id: "image", type: "image", role: "source", label: "Picture" };
const recipe = (id: string, op: string, inputs: unknown[] = []): RecipeInfo => ({ id, family: id.split(".")[0], output: "image", op, title: id, inputs: [source, ...inputs] }) as unknown as RecipeInfo;
const make = { id: "sdxl.text-to-picture", family: "sdxl", output: "image", op: "txt2img", title: "Text to picture", inputs: [{ id: "prompt", type: "prompt" }, { id: "checkpoint", type: "choice" }] } as unknown as RecipeInfo;
const detector = { id: "detector", type: "choice", whenChosen: [{ match: "hand_yolo", values: { denoise: 0.35, crop_factor: 2 } }] };
const all = [make, recipe("sdxl.sharper", "upscale"), recipe("sdxl.fix-face", "face", [{ id: "prompt", type: "prompt" }, { id: "checkpoint", type: "choice" }, detector])];
const place = (options: Record<string, string[]> = { detector: ["bbox/face_yolov8m.pt", "bbox/hand_yolov8s.pt"] }): PassPlace => ({
  all, families: [{ id: "sdxl", name: "SDXL", summary: "" }], ready: () => true, options: () => options, online: true,
});
const made = (id: string) => ({ id, kind: "image", generation: { recipe: "sdxl.text-to-picture", inputs: { prompt: "zz-test a harbour", checkpoint: "zz-test.safetensors" }, resolved: { seed: 7 } }, ancestor: null }) as unknown as AssetDetail;

describe("a pass on each ticked picture", () => {
  it("is the job its own button queues: its model's pass, its parameters carried, itself as the source", () => {
    const job = passJob("upscale", made("zz-test-1"), place());
    expect(job.recipe.id).toBe("sdxl.sharper");
    expect(job).toMatchObject({ label: "Upscale 2x", from: "zz-test-1", stored: { image: "zz-test-1" } });
    const face = passJob("face", made("zz-test-2"), place());
    expect(face.stored).toMatchObject({ image: "zz-test-2", prompt: "zz-test a harbour", checkpoint: "zz-test.safetensors" });
    // never its seed: the pass is a new render of the picture
    expect(face.stored).not.toHaveProperty("seed");
  });

  it("puts Hand refine on the hand detector, and refuses it with the reason when ComfyUI has none", () => {
    expect(passJob("hand", made("zz-test-3"), place()).stored).toMatchObject({ detector: "bbox/hand_yolov8s.pt", denoise: 0.35, crop_factor: 2 });
    expect(() => passJob("hand", made("zz-test-3"), place({ detector: ["bbox/face_yolov8m.pt"] }))).toThrow(NO_HAND_DETECTOR);
    expect(() => passJob("background", made("zz-test-3"), place())).toThrow("No model is installed for it.");
  });

  it("lands Face and Hand refine as versions under each picture, Upscale as a new item (card #274)", () => {
    expect(passJob("face", made("zz-test-4"), place()).versionOf).toBe("zz-test-4");
    expect(passJob("hand", made("zz-test-5"), place()).versionOf).toBe("zz-test-5");
    expect(passJob("upscale", made("zz-test-6"), place())).not.toHaveProperty("versionOf");
  });
});
