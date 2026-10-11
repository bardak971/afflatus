import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, type FakeComfy } from "@afflatus/comfy/testing";
import { chooser, editorFile } from "../../../packages/workflows/test/editor-fixtures";
import { sdxl, wan } from "../../../packages/workflows/test/fixtures";
import { CHECKPOINT, get, makeApp, makeFake, post, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;

beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const inspect = async (graph: unknown) => post(t.app, "/api/workflows/inspect", graph);
/** Import a workflow the way the screen does: inspect, then save what was suggested. */
async function importWan(title = "Wan 2.2 · Picture to video") {
  const found = (await inspect(wan)).json();
  const res = await post(t.app, "/api/workflows", { title, model: "Wan 2.2", source: "wan.json", graph: wan, bindings: found.suggested });
  return res.json() as { id: string };
}

describe("reading a workflow", () => {
  it("says what was found, reading only ComfyUI's node list", async () => {
    const res = await inspect(wan);
    expect(res.statusCode).toBe(200);
    const found = res.json();
    expect(found.suggested).toMatchObject({ result: { node: "63", kind: "video" }, prompt: { node: "6", input: "text" } });
    expect(found.nodeCount).toBe(12);
    expect(fake.calls.every((c) => c.startsWith("GET "))).toBe(true);
  });

  it("reads the file ComfyUI's editor saves, and answers with the workflow in the form Afflatus keeps", async () => {
    const res = await inspect(editorFile);
    expect(res.statusCode).toBe(200);
    const found = res.json();
    expect(found.suggested).toMatchObject({ prompt: { node: "3:6", input: "text" }, result: { node: "9", kind: "image" }, loras: [{ node: "30", power: true }] });
    expect(found.toggles.map((t: { label: string }) => t.label)).toEqual(["🆙 Upscale 2x"]);
    // every node, the switched-off one included, and what only the editor's file knows
    expect(Object.keys(found.graph)).toContain("3:20");
    expect(found.wiring.modes).toEqual({ "3:20": "bypass" });
    expect(fake.calls.every((c) => c.startsWith("GET "))).toBe(true);
  });

  it("says so when the editor's file holds nothing ComfyUI can run", async () => {
    const res = await inspect({ last_node_id: 9, nodes: [{ id: 1, type: "MarkdownNote", widgets_values: ["hello"] }], links: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("No node that ComfyUI can run");
  });

  it("refuses, in plain words, an editor's file that is not what it says, and nothing reaches Object.prototype", async () => {
    const crafted = {
      nodes: [
        { id: 2, type: "Source", outputs: [{ type: "STRING", links: [1] }] },
        { id: "__proto__", type: "Sink", inputs: [{ name: "polluted", type: "STRING", link: 1, widget: { name: "polluted" } }], widgets_values: ["PWNED"] },
      ],
      links: [[1, 2, 0, "__proto__", 0, "STRING"]],
    };
    const res = await inspect(crafted);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/could not be read as a workflow of ComfyUI's editor/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // a node that is not one, and a group node that holds itself: a 400 that says so, not a 500
    expect((await inspect({ nodes: [null], links: [] })).statusCode).toBe(400);
    const loop = await inspect({ nodes: [{ id: 1, type: "loop" }], links: [], definitions: { subgraphs: [{ id: "loop", nodes: [{ id: 1, type: "loop" }], links: [] }] } });
    expect(loop.statusCode).toBe(400);
    expect(loop.json().error).toMatch(/holds itself/);
  });

  it("refuses what is not a workflow", async () => {
    expect((await inspect({ hello: "world" })).statusCode).toBe(400);
    expect((await inspect({})).statusCode).toBe(400);
  });

  it("says that ComfyUI has to be running", async () => {
    await fake.close();
    const res = await inspect(wan);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("ComfyUI has to be running");
  });
});

describe("an imported workflow", () => {
  it("becomes a recipe with its own form, listed with the built-in ones", async () => {
    const { id } = await importWan();
    expect(id).toBe("workflow.wan-2-2-picture-to-video");
    const { families, recipes } = (await get(t.app, "/api/recipes")).json();
    expect(families.map((f: { name: string }) => f.name)).toEqual(["SDXL", "FLUX.2 Klein", "Krea 2", "FLUX.1", "Qwen Image", "Qwen Image 2.1", "Z-Image", "MiniMax H3", "Wan 2.2", "LTX 2.3", "Image tools", "Wan 2.2"]);
    const recipe = recipes.find((r: { id: string }) => r.id === id);
    expect(recipe).toMatchObject({ title: "Wan 2.2 · Picture to video", output: "video", family: "workflow-wan-2-2" });
    expect(recipe.inputs.map((i: { id: string }) => i.id)).toContain("seconds");
    expect(recipe.traits).toMatchObject({ startFrame: true, endFrame: true });
    expect((await get(t.app, "/api/workflows")).json().items).toEqual([{ id, title: "Wan 2.2 · Picture to video", model: "Wan 2.2", source: "wan.json", output: "video", nodes: 12 }]);
  });

  it("is checked against ComfyUI like any recipe: nodes and the files it names", async () => {
    const { id } = await importWan();
    const status = (await get(t.app, "/api/setup")).json().recipes.find((r: { id: string }) => r.id === id);
    // the saved catalog has no file lists, so nothing can be called missing
    expect(status).toMatchObject({ ready: true, missingNodes: [], missingFiles: [] });

    // on a ComfyUI that lists its files, a model the workflow names and that is not there is reported
    fake.catalog.UNETLoader!.input.required!.unet_name = [["some-other-model.safetensors"]];
    const again = (await post(t.app, "/api/setup/rescan")).json().recipes.find((r: { id: string }) => r.id === id);
    expect(again).toMatchObject({ ready: false, missingFiles: ["wan2.2_i2v_14B.safetensors"] });
  });

  it("runs with a model this ComfyUI keeps in another sub-folder, named as ComfyUI lists it", async () => {
    const { id } = await importWan();
    fake.catalog.UNETLoader!.input.required!.unet_name = [["Wan\\wan2.2_i2v_14B.safetensors"]];
    const status = (await post(t.app, "/api/setup/rescan")).json().recipes.find((r: { id: string }) => r.id === id);
    expect(status).toMatchObject({ ready: true, missingFiles: [] });
    expect((await post(t.app, "/api/jobs", { recipe: id, input: { prompt: "a cat walks" } })).statusCode).toBe(200);
    await until(() => fake.prompts.size === 1);
    const graph = [...fake.prompts.values()][0]!;
    expect(Object.values(graph).find((n) => n.class_type === "UNETLoader")!.inputs.unet_name).toBe("Wan\\wan2.2_i2v_14B.safetensors");
  });

  it("gets a second id when the title is already taken, and survives a restart", async () => {
    await importWan();
    expect((await importWan()).id).toBe("workflow.wan-2-2-picture-to-video-2");
    const again = await makeApp({ db: t.db, dir: t.dir, comfyUrl: fake.url });
    expect((await get(again.app, "/api/workflows")).json().items).toHaveLength(2);
    await again.app.close();
  });

  it("renders through the queue: the form's values go into the workflow, the video lands in the library", async () => {
    const { id } = await importWan();
    const res = await post(t.app, "/api/jobs", { recipe: id, input: { prompt: "She waves at the boat.", seconds: 3, ctl_57_steps: 8 } });
    expect(res.statusCode).toBe(200);
    await until(() => fake.prompts.size === 1);
    const [promptId, graph] = [...fake.prompts.entries()][0]!;
    expect(graph["6"]!.inputs.text).toBe("She waves at the boat.");
    expect(graph["50"]!.inputs.length).toBe(49);
    expect(graph["57"]!.inputs.steps).toBe(8);
    expect(graph["57"]!.inputs.seed).not.toBe(42);
    // no pictures were given: both optional loaders are taken out
    expect(graph["52"]).toBeUndefined();
    expect(graph["53"]).toBeUndefined();

    fake.files["clip.mp4"] = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    fake.pending = [];
    fake.history[promptId] = { status: { completed: true }, outputs: { "63": { gifs: [{ filename: "clip.mp4", subfolder: "", type: "temp" }] } } };
    await until(async () => (await get(t.app, "/api/assets")).json().items.length === 1);
    const asset = (await get(t.app, "/api/assets")).json().items[0];
    expect(asset).toMatchObject({ kind: "video", mime: "video/mp4", origin: "generated" });
    expect((await get(t.app, `/api/assets/${asset.id}`)).json().generation).toMatchObject({ recipe: id, family: "workflow-wan-2-2", inputs: { seconds: 3 } });

    // the result's graph in ComfyUI's editor: built again with the same seed, written as an editor file
    const opened = await post(t.app, `/api/assets/${asset.id}/open`);
    expect(opened.statusCode).toBe(200);
    const path = `workflows/afflatus/Render ${asset.name || asset.id.slice(0, 8)}.json`;
    expect(opened.json()).toMatchObject({ direct: false, path });
    const file = fake.userdata[path] as { nodes: Array<{ id: number; type: string; widgets_values?: unknown[] }> };
    const sampler = file.nodes.find((n) => n.type === "KSampler")!;
    expect(sampler.widgets_values![0]).toBe(graph["57"]!.inputs.seed);
    expect(sampler.widgets_values![2]).toBe(8);
  });

  it("files the video when the node also hands back a picture of its last frame", async () => {
    const { id } = await importWan();
    await post(t.app, "/api/jobs", { recipe: id, input: { prompt: "She waves." } });
    await until(() => fake.prompts.size === 1);
    const promptId = [...fake.prompts.keys()][0]!;
    fake.files["clip.webm"] = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
    fake.files["clip-last-frame.png"] = makePng(32, 24, [1, 2, 3], [4, 5, 6]);
    fake.pending = [];
    fake.history[promptId] = { status: { completed: true }, outputs: { "63": {
      images: [{ filename: "clip-last-frame.png", subfolder: "", type: "output" }],
      gifs: [{ filename: "clip.webm", subfolder: "", type: "output" }],
    } } };
    await until(async () => (await get(t.app, "/api/assets")).json().items.length > 0);
    const items = (await get(t.app, "/api/assets")).json().items;
    expect(items.map((a: { kind: string; mime: string }) => [a.kind, a.mime])).toEqual([["video", "video/webm"]]);
  });

  it("refuses inputs its form does not have", async () => {
    const { id } = await importWan();
    const res = await post(t.app, "/api/jobs", { recipe: id, input: { seconds: 500 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("seconds");
  });

  it("can be read back whole (to edit or share), changed, and removed", async () => {
    const { id } = await importWan();
    const def = (await get(t.app, `/api/workflows/${id}`)).json();
    expect(def.graph["50"].class_type).toBe("WanFirstLastFrameToVideo");

    const put = await t.app.inject({ method: "PUT", url: `/api/workflows/${id}`, payload: { title: "Wan, renamed", model: "Wan 2.2", source: def.source, graph: def.graph, bindings: { ...def.bindings, controls: [] } } });
    expect(put.json()).toMatchObject({ id, title: "Wan, renamed" });
    const recipe = (await get(t.app, "/api/recipes")).json().recipes.find((r: { id: string }) => r.id === id);
    expect(recipe.inputs.some((i: { id: string }) => i.id.startsWith("ctl_"))).toBe(false);

    expect((await t.app.inject({ method: "DELETE", url: `/api/workflows/${id}` })).statusCode).toBe(200);
    const left = (await get(t.app, "/api/recipes")).json().recipes.map((r: { id: string }) => r.id);
    expect(left).toContain("sdxl.text-to-picture");
    expect(left.filter((r: string) => r.startsWith("workflow."))).toEqual([]);
    expect((await get(t.app, `/api/workflows/${id}`)).statusCode).toBe(404);
  });

  it("is refused when the mapping points at something that is not in the workflow", async () => {
    const found = (await inspect(sdxl)).json();
    const broken = { ...found.suggested, prompt: { node: "999", input: "text" } };
    const res = await post(t.app, "/api/workflows", { title: "Broken", model: "SDXL", graph: sdxl, bindings: broken });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("node 999");
  });

  /** A Director whose saved data this version cannot read: its graph cannot be built. */
  const director = {
    "1": { class_type: "MiniMaxH3Director", inputs: { timeline_data: "not json", mode: "T2VA", prompt: "a boat" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } },
  };
  const directorBindings = { result: { node: "2", kind: "image" }, director: { node: "1" } };

  it("is refused when it cannot be built as mapped, before anything is kept", async () => {
    const res = await post(t.app, "/api/workflows", { title: "Director", model: "MiniMax H3", graph: director, bindings: directorBindings });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/cannot be run as it is mapped: .*Director/);
    expect((await get(t.app, "/api/workflows")).json().items).toEqual([]);
  });

  it("does not keep the server from starting when a saved one cannot be built: it is listed with why, and can be removed", async () => {
    await importWan();
    // as an older version kept it, before builds were checked
    const def = { id: "workflow.director", title: "Director", model: "MiniMax H3", source: "", graph: director, bindings: directorBindings };
    await t.db.insertInto("workflows").values({ id: def.id, owner_id: "owner", def: JSON.stringify(def), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).execute();
    const again = await makeApp({ db: t.db, dir: t.dir, comfyUrl: fake.url });
    const items = (await get(again.app, "/api/workflows")).json().items as Array<{ id: string; problem?: string }>;
    expect(items.map((i) => i.id).sort()).toEqual(["workflow.director", "workflow.wan-2-2-picture-to-video"]);
    expect(items.find((i) => i.id === "workflow.director")!.problem).toMatch(/Director/);
    const recipes = (await get(again.app, "/api/recipes")).json().recipes.map((r: { id: string }) => r.id);
    expect(recipes).toContain("workflow.wan-2-2-picture-to-video");
    expect(recipes).not.toContain("workflow.director");
    expect((await again.app.inject({ method: "DELETE", url: "/api/workflows/workflow.director" })).statusCode).toBe(200);
    await again.app.close();
  });
});

describe("a workflow imported from the editor's own file", () => {
  // the same file, naming a checkpoint the pretend ComfyUI has
  const file = structuredClone(editorFile);
  file.nodes.find((n) => n.type === "CheckpointLoaderSimple")!.widgets_values = [CHECKPOINT];

  async function importSettings() {
    const found = (await inspect(file)).json();
    const res = await post(t.app, "/api/workflows", { title: "Settings", model: "SDXL custom", source: "settings.json", graph: found.graph, wiring: found.wiring, bindings: found.suggested });
    expect(res.statusCode).toBe(200);
    return res.json() as { id: string };
  }

  it("has its switch and its own LoRAs on the form", async () => {
    const { id } = await importSettings();
    const recipe = (await get(t.app, "/api/recipes")).json().recipes.find((r: { id: string }) => r.id === id);
    expect(recipe.inputs.find((i: { id: string }) => i.id === "sw_3_enabled")).toMatchObject({ type: "toggle", label: "🆙 Upscale 2x", default: false });
    expect(recipe.inputs.find((i: { id: string }) => i.id === "loras")).toMatchObject({ default: [{ file: "style.safetensors", weight: 0.8 }, { file: "unused.safetensors", weight: 0 }] });
    const status = (await get(t.app, "/api/setup")).json().recipes.find((r: { id: string }) => r.id === id);
    expect(status).toMatchObject({ ready: true, missingNodes: [] });
  });

  it("sends the part a switch controls only when the switch is on", async () => {
    const { id } = await importSettings();
    await post(t.app, "/api/jobs", { recipe: id, input: { prompt: "a dog" } });
    await until(() => fake.prompts.size === 1);
    const off = [...fake.prompts.values()][0]!;
    expect(off["3:20"]).toBeUndefined();
    expect(off["9"]!.inputs.images).toEqual(["3:8", 0]);
    expect(off["3:6"]!.inputs.text).toBe("a dog");
    expect(off["30"]!.inputs.lora_1).toEqual({ on: true, lora: "style.safetensors", strength: 0.8 });

    const res = await post(t.app, "/api/jobs", { recipe: id, input: { prompt: "a dog", sw_3_enabled: true, loras: [] } });
    expect(res.statusCode).toBe(200);
    // the first job has to leave ComfyUI before the second is sent
    const first = [...fake.prompts.keys()][0]!;
    fake.files["first.png"] = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0, 0, 0, 3, 0, 8, 2, 0, 0, 0, 0, 0, 0, 0]);
    fake.pending = [];
    fake.history[first] = { status: { completed: true }, outputs: { "9": { images: [{ filename: "first.png", subfolder: "", type: "output" }] } } };
    await until(() => fake.prompts.size === 2);
    const on = [...fake.prompts.values()][1]!;
    expect(on["3:20"]!.class_type).toBe("ImageScaleBy");
    expect(on["9"]!.inputs.images).toEqual(["3:20", 0]);
    expect(Object.keys(on["30"]!.inputs)).toEqual(["model", "clip"]);
  });

  it("is checked like any recipe when it cannot run without a picture", async () => {
    const found = (await inspect(chooser)).json();
    expect(found.suggested.startImage.required).toBe(true);
    const saved = (await post(t.app, "/api/workflows", { title: "Chooser", model: "Test", source: "chooser.json", graph: found.graph, bindings: found.suggested })).json();
    const setup = await post(t.app, "/api/setup/rescan");
    expect(setup.statusCode).toBe(200);
    expect(setup.json().recipes.find((r: { id: string }) => r.id === saved.id)).toMatchObject({ ready: true });
    // and a job without the picture is refused with a reason, before anything is queued
    const res = await post(t.app, "/api/jobs", { recipe: saved.id, input: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("startImage");
  });

  it("sends the picture the user gave, on a ComfyUI that lists its input pictures", async () => {
    // as a real ComfyUI does: the list holds what was in its input folder before the upload
    fake.catalog.LoadImage!.input.required!.image = [["example.png", "older.png"]];
    const found = (await inspect(chooser)).json();
    const saved = (await post(t.app, "/api/workflows", { title: "Chooser", model: "Test", source: "chooser.json", graph: found.graph, bindings: found.suggested })).json();
    const picture = (await t.app.inject({ method: "POST", url: "/api/assets?name=mine.png", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 48, [10, 20, 30], [200, 210, 220])) })).json();
    const res = await post(t.app, "/api/jobs", { recipe: saved.id, input: { startImage: picture.id } });
    expect(res.statusCode).toBe(200);
    await until(() => fake.prompts.size === 1);
    const graph = [...fake.prompts.values()][0]!;
    expect(fake.uploads).toHaveLength(1);
    expect(String(graph["1"]!.inputs.image)).toContain(fake.uploads[0]!);
  });

  it("shows the same switches when it is opened again to be changed", async () => {
    const { id } = await importSettings();
    const def = (await get(t.app, `/api/workflows/${id}`)).json();
    expect(def.wiring.toggles).toHaveLength(1);
    const again = (await inspect({ graph: def.graph, wiring: def.wiring })).json();
    expect(again.toggles.map((x: { id: string }) => x.id)).toEqual(["sw_3_enabled"]);
    expect(again.suggested.prompt).toEqual({ node: "3:6", input: "text" });
    expect(again.wiring.modes).toEqual({ "3:20": "bypass" });
  });
});

describe("opening a workflow in ComfyUI", () => {
  it("writes the editor's own file, kept at import, into ComfyUI's workflows folder", async () => {
    const found = (await inspect(editorFile)).json();
    expect(found.editor).toEqual(editorFile);
    const saved = (await post(t.app, "/api/workflows", { title: "Mine", model: "Wan 2.2", source: "mine.json", graph: found.graph, wiring: found.wiring, editor: found.editor, bindings: found.suggested })).json();
    const res = await post(t.app, `/api/workflows/${saved.id}/open`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: fake.url, path: "workflows/afflatus/Mine.json", direct: false });
    expect(fake.userdata["workflows/afflatus/Mine.json"]).toEqual(editorFile);
  });

  it("writes the graph as the editor would save it when there is no editor file", async () => {
    const { id } = await importWan("Wan · from the API file");
    const res = await post(t.app, `/api/workflows/${id}/open`);
    expect(res.statusCode).toBe(200);
    const file = fake.userdata["workflows/afflatus/Wan · from the API file.json"] as { nodes: Array<{ type: string; widgets_values: unknown }>; links: unknown[]; version: number };
    expect(file.version).toBe(0.4);
    expect(file.nodes.map((n) => n.type)).toContain("VHS_VideoCombine");
    expect(file.nodes.find((n) => n.type === "LoadImage")?.widgets_values).toEqual(["first.png", "image"]);
    expect(file.links.length).toBeGreaterThan(5);
  });
});

describe("opening a workflow in ComfyUI through its folder", () => {
  it("writes the helper pack and the file, and falls back to the sidebar until ComfyUI has started with the pack", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "afflatus-comfy-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "custom_nodes"));
    try {
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyDir: dir } });
      const { id } = await importWan("Wan for the pack");
      const res = await post(t.app, `/api/workflows/${id}/open`);
      expect(res.statusCode).toBe(200);
      // the pretend ComfyUI does not serve the pack yet: the sidebar way, with a word about the restart
      expect(res.json()).toMatchObject({ url: fake.url, direct: false, restart: true, path: "workflows/afflatus/Wan for the pack.json" });
      const written = JSON.parse(await readFile(join(dir, "custom_nodes", "afflatus-workflows", "example_workflows", `${id.replace(/^workflow\./, "")}.json`), "utf-8")) as { nodes: unknown[] };
      expect(written.nodes.length).toBe(12);
      expect(await readFile(join(dir, "custom_nodes", "afflatus-workflows", "__init__.py"), "utf-8")).toContain("NODE_CLASS_MAPPINGS = {}");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a folder that is not ComfyUI's", async () => {
    const { tmpdir } = await import("node:os");
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyDir: tmpdir() } });
    const { id } = await importWan("Wan elsewhere");
    const res = await post(t.app, `/api/workflows/${id}/open`);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("custom_nodes");
  });
});
