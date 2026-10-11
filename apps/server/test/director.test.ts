import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/** A small PNG made with ffmpeg (skipped where ffmpeg is not installed). */
function makePicture(): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-pic-"));
  const file = join(dir, "p.png");
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=steelblue:s=64x48", "-frames:v", "1", file]);
  const bytes = made.status === 0 ? new Uint8Array(readFileSync(file)) : null;
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}
const picture = makePicture();

/** The DaSiWa H3 Director, as its pack declares it (enough for the importer and the graph check). */
const DIRECTOR = {
  input: {
    required: {
      mode: [["T2VA", "I2VA", "FL2VA", "L2VA", "REF2VA", "Image Inpaint"], { default: "FL2VA" }],
      prompt: ["STRING", { multiline: true }], width: ["INT", { default: 1344, min: 16, max: 8192, step: 16 }], height: ["INT", { default: 768, min: 16, max: 8192, step: 16 }],
      duration: ["FLOAT", { default: 5 }], ref_image_size: [["match", "max"]], timeline_data: ["STRING", {}], builder_state: ["STRING", {}], frame_rate: ["FLOAT", { default: 24 }],
    },
    optional: {},
  },
  output: ["MINIMAX_H3_DIRECTOR_GUIDE", "INT", "STRING", "INT", "INT", "MODEL", "BOOLEAN", "BOOLEAN", "FLOAT"],
  output_name: ["guide", "duration", "positive_prompt", "width", "height", "model", "fl2va_requested", "inpaint_requested", "frame_rate"],
  name: "MiniMaxH3Director", display_name: "MiniMax H3 Director", category: "DaSiWa/MiniMax H3", output_node: false,
};
const workflow = {
  "1": { class_type: "MiniMaxH3Director", inputs: { mode: "T2VA", prompt: "a boat", width: 512, height: 384, duration: 2, ref_image_size: "match", timeline_data: JSON.stringify({ version: 1, items: [], prompt_blocks: [] }), builder_state: "", frame_rate: 24 } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } },
};

describe.skipIf(!picture)("a picture for the DaSiWa Director", () => {
  let fake: FakeComfy;
  let t: TestApp;
  beforeEach(async () => {
    fake = await startFakeComfy({ catalog: { ...referenceCatalog(), MiniMaxH3Director: DIRECTOR } as never, models: {} });
    t = await makeApp({ comfyUrl: fake.url });
    await t.services.queue.start();
  });
  afterEach(async () => {
    await t.close();
    await fake.close().catch(() => {});
  });

  it("goes to ComfyUI's input folder and into the Director's first slot; the old pictures there are cleaned", async () => {
    const found = (await post(t.app, "/api/workflows/inspect", workflow)).json();
    expect(found.suggested.director).toEqual({ node: "1" });
    const { id } = (await post(t.app, "/api/workflows", { title: "Director", model: "H3", source: "d.json", graph: found.graph, bindings: found.suggested })).json();
    const asset = (await t.app.inject({ method: "POST", url: "/api/assets?name=start.png", headers: { "content-type": "image/png" }, payload: Buffer.from(picture!) })).json();
    await post(t.app, "/api/jobs", { recipe: id, input: { startImage: asset.id } });
    await until(() => fake.prompts.size === 1);
    const sent = [...fake.prompts.values()][0]!["1"]!.inputs;
    const items = JSON.parse(String(sent.timeline_data)).items as Array<{ slot: number; value: string; type: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "image", slot: 0 });
    expect(items[0]!.value).toMatch(/^afflatus\/afflatus_.*\.png$/);
    expect(sent.mode).toBe("I2VA");
    expect(fake.cleaned).toContainEqual({ older_than_hours: 24 });
  });
});
