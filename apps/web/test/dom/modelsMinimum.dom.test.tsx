import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import type { RecipeInfo, RecipeStatus } from "../../src/api";
import { ModelsCard } from "../../src/screens/settings/ModelsTab";
import type { Slot } from "../../src/screens/settings/ModelsFamily";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Settings › Models as a newcomer meets it (the #143 audit, mock 0.8.1 screen 2): each family says what its first
 * operation needs, the same count as its Get the minimum, with what it weighs; and with nothing able to download here, one
 * line at the top says why, with its two ways out.
 */

const H3 = ["unet", "clip", "videoVae", "audioVae"];
const url = (id: string) => `https://example.test/${id}.safetensors`;
const slot = (id: string, over: Partial<Slot> = {}): Slot => ({ id, label: id, folder: "diffusion_models", file: null, choices: [], auto: null, chosen: false, optional: false, hint: `Put ${id} in.`, get: { file: `${id}.safetensors`, url: url(id) }, ...over });
const recipe = (id: string, title: string, over: Partial<RecipeInfo> = {}): RecipeInfo => ({ id, family: "h3", version: 1, title, summary: `${title}.`, output: "video", inputs: [], traits: null, ...over });
const status = (id: string, over: Partial<RecipeStatus> = {}): RecipeStatus => ({ id, ready: false, missingNodes: [], missingSlots: [], emptyInputs: [], missingFiles: [], missing: [], problems: [], limitedBy: [], options: {}, ...over });

function serve(via: "afflatus" | "none") {
  const slots = [...H3.map((id) => slot(id)), slot("swapUnet", { optional: true }), slot("swapLora", { optional: true, folder: "loras" })];
  fakeApi.on("GET /setup", {
    comfy: { online: true, url: "http://127.0.0.1:8188", version: "0.3.68", device: "cuda", vramTotal: 0, vramFree: 0, nodes: 900 },
    families: [{ id: "h3", slots }],
    recipes: [status("h3.video", { missingSlots: H3 }), status("h3.swap", { missingSlots: [...H3, "swapUnet", "swapLora"] })],
  });
  fakeApi.on("GET /settings", { downloadModels: false, civitaiLookups: false, slotFiles: {}, families: {}, allFamilies: true, machines: [{ id: "m1", url: "http://127.0.0.1:8188" }] });
  fakeApi.on("GET /recipes", {
    families: [{ id: "h3", name: "MiniMax H3", summary: "Video with audio.", slots: slots.map((s) => ({ id: s.id, folder: s.folder, optional: s.optional, get: s.get })) }],
    recipes: [recipe("h3.video", "Video with audio"), recipe("h3.swap", "Swap character", { needs: ["swapUnet", "swapLora"] })],
  });
  fakeApi.on("GET /official-sizes", { sizes: Object.fromEntries(H3.map((id) => [url(id), 8 * 2 ** 30])), asking: false });
  fakeApi.on("GET /downloads", { on: false, items: [], manager: { found: false }, via });
}

describe("Settings › Models, a family's head", () => {
  it("says what its first operation needs, the count its Get the minimum fetches, with their size", async () => {
    serve("afflatus");
    draw(<ModelsCard />);
    expect((await screen.findAllByText((_, el) => el?.tagName === "SPAN" && el.textContent === "Video with audio needs 4 files · 32.0 GB")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Get the minimum · 4 files · 32.0 GB" })).toBeTruthy();
    // Swap's two files are only in Everything, whose size is not known in full
    expect(screen.getByRole("button", { name: "Everything · 6 · 32.0 GB+" })).toBeTruthy();
    expect(screen.queryByText(/Nothing can download/)).toBeNull();
  });
});

describe("Settings › Models with nothing able to download here", () => {
  it("says so once at the top, with the folder and a pod as the ways out", async () => {
    serve("none");
    draw(<ModelsCard />);
    const line = (await screen.findByText(/Nothing can download into this ComfyUI yet/)).closest("div")!;
    expect(within(line).getByRole("link", { name: "Set the folder" }).getAttribute("href")).toMatch(/find=comfy\.folder/);
    expect(within(line).getByRole("link", { name: "Or a pod fetches them" }).getAttribute("href")).toMatch(/find=comfy\.runpod/);
    // the family's buttons stay, off, not in the accent colour of a live action
    const least = await screen.findByRole("button", { name: /Get the minimum/ });
    expect((least as HTMLButtonElement).disabled).toBe(true);
  });
});
