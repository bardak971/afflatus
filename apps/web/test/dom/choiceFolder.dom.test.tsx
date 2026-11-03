import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import type { InputSpec } from "@afflatus/core";
import { Field } from "../../src/fields";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * A choice read from a node's file input searches its files in the folder core says that input reads (folderOfFileInput):
 * the page had its own table, which sent a CLIP vision loader's clip_name to text_encoders and knew no upscaler, LoRA
 * input but lora_name, detector or SAM file (the 2026-11-02 review, card #258).
 */

function serve() {
  fakeApi.on("GET /settings", { machines: [] });
  fakeApi.on("GET /setup", { comfy: { online: true }, recipes: [], lists: [], places: { on: {}, offered: {}, down: {} } });
  fakeApi.on("GET /official-sizes", { sizes: {}, asking: false });
  fakeApi.on("GET /models/:folder/info", { items: {}, pending: 0 });
  fakeApi.on("GET /models/updates", { items: [] });
  fakeApi.on("GET /model-words", { items: {} });
}

const FILES = ["a.safetensors", "b.safetensors", "c.safetensors", "zz-test-long-name.safetensors", "d.safetensors"];
const choice = (node: string, input: string) => ({ id: "pick", type: "choice", label: "Model", options: { node, input }, default: FILES[0] }) as unknown as InputSpec;
const asked = () => fakeApi.calls("GET", "/models/").map((c) => c.path);

describe("a choice of a node's model files", () => {
  it.each([
    ["CLIPVisionLoader", "clip_name", "clip_vision"],
    ["UpscaleModelLoader", "model_name", "upscale_models"],
    ["UltralyticsDetectorProvider", "model_name", "ultralytics"],
  ])("reads %s's %s from %s", async (node, input, folder) => {
    serve();
    draw(<Field spec={choice(node, input)} value={FILES[0]} options={FILES} onChange={() => {}} />);
    await waitFor(() => expect(asked()).toContain(`/models/${folder}/info`));
  });
});
