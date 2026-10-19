import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { RecipeInfo, RecipeStatus } from "../../src/api";
import { DownloadAll, FamilyBody, type Slot } from "../../src/screens/settings/ModelsFamily";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Settings › Models, an opened family as the owner picked it (2026-10-17, mock "Models view", A): each file said once, with
 * the operations that use it, then a line per operation. Before, FLUX.1 said its four files under each of its operations.
 */

const slot = (id: string, label: string, over: Partial<Slot> = {}): Slot => ({ id, label, folder: "diffusion_models", file: null, choices: [], auto: null, chosen: false, optional: false, hint: `Put ${id}.safetensors in ComfyUI's models folder.`, get: { file: `${id}.safetensors`, url: `https://example.test/${id}.safetensors` }, ...over });
const recipe = (id: string, title: string, over: Partial<RecipeInfo> = {}): RecipeInfo => ({ id, family: "flux", version: 1, title, summary: `${title} does a thing.`, output: "image", inputs: [], traits: null, ...over });
const status = (id: string, over: Partial<RecipeStatus> = {}): RecipeStatus => ({ id, ready: false, missingNodes: [], missingSlots: [], emptyInputs: [], missingFiles: [], missing: [], problems: [], limitedBy: [], options: {}, ...over });

const BASE = ["unet", "clip", "t5", "vae"];
const recipes = [recipe("flux.t2i", "txt2img"), recipe("flux.edit", "Edit", { needs: ["kontext"] }), recipe("flux.i2i", "img2img")];

function serve(slots: Slot[], statuses: RecipeStatus[], downloads: unknown[] = []) {
  fakeApi.on("GET /setup", { comfy: { online: true, url: "http://127.0.0.1:8188" }, families: [{ id: "flux", slots }], recipes: statuses });
  fakeApi.on("GET /settings", { downloadModels: true, civitaiLookups: false, slotFiles: {} });
  fakeApi.on("GET /downloads", { on: true, items: downloads, manager: { found: false }, via: "afflatus" });
}

describe("an opened family, each file once", () => {
  it("lists the four shared files and Edit's Kontext model once each, and each operation says what it waits for", async () => {
    const slots = [...BASE.map((id) => slot(id, id.toUpperCase())), slot("kontext", "Kontext model", { optional: true })];
    serve(slots, [status("flux.t2i", { missingSlots: BASE }), status("flux.edit", { missingSlots: [...BASE, "kontext"] }), status("flux.i2i", { missingSlots: BASE })]);
    draw(<FamilyBody family="flux" name="FLUX.1" recipes={recipes} />);
    const files = within(await screen.findByRole("region", { name: "Files" }));
    for (const label of ["UNET", "CLIP", "T5", "VAE", "Kontext model"]) expect(files.getAllByText(label)).toHaveLength(1);
    expect(files.getByText("Edit only")).toBeTruthy();
    expect(files.getByText("5 missing")).toBeTruthy();
    const ops = within(screen.getByRole("region", { name: "Operations" }));
    expect(ops.getAllByText("needs the 4 files above")).toHaveLength(2);
    expect(ops.getByText("needs the 4 files above + Kontext model ↑")).toBeTruthy();
    // the Kontext model is needed by Edit, not offered as optional
    expect(screen.queryByText(/^Optional ·/)).toBeNull();
  });

  it("shows the needed files once opened, saying nothing of them all being there, and folds the optional ones there behind one line", async () => {
    const slots = [
      ...BASE.map((id) => slot(id, id.toUpperCase(), { file: `${id}.safetensors` })),
      slot("kontext", "Kontext model", { optional: true, file: "kontext.safetensors" }),
      slot("seedvr", "SeedVR2 model", { optional: true, file: "seedvr2_3b.safetensors", choices: ["seedvr2_3b.safetensors", "seedvr2_7b.safetensors"], auto: "seedvr2_3b.safetensors" }),
    ];
    serve(slots, recipes.map((r) => status(r.id, { ready: true })));
    const { user } = draw(<FamilyBody family="flux" name="FLUX.1" recipes={recipes} />);
    const files = within(await screen.findByRole("region", { name: "Files" }));
    expect(files.queryByText("all there")).toBeNull();
    // the four shared files and Edit's Kontext model, in sight without a click
    expect(files.getByText("UNET")).toBeTruthy();
    expect(files.getByText("Kontext model")).toBeTruthy();
    expect(files.queryByRole("button", { name: /File used for SeedVR2 model/ })).toBeNull();
    await user.click(files.getByRole("button", { name: "1 more" }));
    expect(files.getByRole("button", { name: /File used for SeedVR2 model/ })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Operations" })).getAllByText("Ready")).toHaveLength(3);
  });
});

describe("a file only hidden recipes use", () => {
  it("is left out of the optional files, though it is there (Swap's, in a release that hides it)", async () => {
    const slots = [
      ...BASE.map((id) => slot(id, id.toUpperCase(), { file: `${id}.safetensors` })),
      slot("seedvr", "SeedVR2 model", { optional: true, file: "seedvr2_3b.safetensors" }),
      slot("swapUnet", "Reference model for Swap", { optional: true, file: "ref2va.safetensors", onlyHidden: true }),
    ];
    serve(slots, recipes.map((r) => status(r.id, { ready: true })));
    const { user } = draw(<FamilyBody family="flux" name="FLUX.1" recipes={recipes} />);
    const files = within(await screen.findByRole("region", { name: "Files" }));
    await user.click(files.getByRole("button", { name: "1 more" }));
    expect(files.getByRole("button", { name: /File used for SeedVR2 model/ })).toBeTruthy();
    expect(files.queryByText(/Reference model for Swap/)).toBeNull();
  });
});

describe("a file there, its picker", () => {
  it("is a picker with one file too, its last entry Another file… opening where to get one", async () => {
    const slots = [slot("unet", "UNET", { file: "unet.safetensors", choices: ["unet.safetensors"], get: { file: "flux1-dev.safetensors", url: "https://example.test/flux1-dev.safetensors" } })];
    serve(slots, [status("flux.t2i", { ready: true })]);
    const { user } = draw(<FamilyBody family="flux" name="FLUX.1" recipes={[recipe("flux.t2i", "txt2img")]} />);
    const files = within(await screen.findByRole("region", { name: "Files" }));
    await user.click(files.getByRole("button", { name: /File used for UNET/ }));
    await user.click(await screen.findByRole("option", { name: /Another file…/ }));
    expect(files.getByText(/Another UNET: put its file in ComfyUI's diffusion_models folder/)).toBeTruthy();
    // the file Afflatus knows for it, not the one there, offered to download
    expect(files.getByRole("button", { name: /Download into ComfyUI/ })).toBeTruthy();
  });
});

describe("Download all", () => {
  it("starts the needed files it lacks that have a download, not the optional ones nor one already coming", async () => {
    const slots = [...BASE.map((id) => slot(id, id.toUpperCase())), slot("lora", "Turbo LoRA", { optional: true })];
    serve(slots, recipes.map((r) => status(r.id, { missingSlots: BASE })), [{ id: "d1", file: "vae.safetensors", folder: "diffusion_models", status: "downloading", bytes: 1, total: 2 }]);
    const asked: string[] = [];
    fakeApi.on("POST /downloads", ({ body }) => {
      asked.push((body as { file: string }).file);
      return { id: `d-${asked.length}`, status: "starting" };
    });
    const { user } = draw(<DownloadAll family="flux" recipes={recipes} />);
    await user.click(await screen.findByRole("button", { name: /Download all · 3 files/ }));
    await waitFor(() => expect(asked.sort()).toEqual(["clip.safetensors", "t5.safetensors", "unet.safetensors"]));
  });
});
