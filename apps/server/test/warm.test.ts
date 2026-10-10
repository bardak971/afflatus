import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { CHECKPOINT, complete, get, job, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;

beforeEach(async () => {
  const catalog = referenceCatalog();
  catalog.LoraLoader!.input.required!.lora_name = [["a.safetensors", "b.safetensors"]];
  fake = await startFakeComfy({ catalog, models: { checkpoints: [CHECKPOINT, "other.safetensors"], loras: ["a.safetensors", "b.safetensors"], upscale_models: [] } });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const submitted = () => [...fake.prompts.keys()];
const frees = () => fake.calls.filter((c) => c === "POST /free").length;
const statusOf = async (id: string) => (await t.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow()).status;
const render = async (over: Record<string, unknown>) => {
  const id = (await post(t.app, "/api/jobs", job(over))).json().ids[0] as string;
  const n = submitted().length;
  await until(() => submitted().length === n + 1);
  complete(fake, submitted().at(-1)!);
  await until(async () => (await statusOf(id)) === "done");
  // what the queue notes of the render (the model it left loaded) is written after the job is said done
  await t.services.queue.idle();
};
/** A prompt that saves nothing is done: what a warm-up leaves in ComfyUI's history. */
const done = (promptId: string) => {
  fake.pending = fake.pending.filter((p) => p !== promptId);
  fake.history[promptId] = { status: { completed: true }, outputs: {} };
};
const form = (over: Record<string, unknown> = {}) => ({ recipe: "sdxl.text-to-picture", input: { prompt: "", checkpoint: CHECKPOINT, ...over } });

describe("ComfyUI's memory is cleared for another base model only", () => {
  it("keeps the checkpoint through another LoRA, and clears for another checkpoint", async () => {
    await render({});
    expect(frees()).toBe(1); // nothing known to be loaded: cleared first
    await render({ loras: [{ file: "a.safetensors", weight: 1 }] });
    await render({ loras: [{ file: "b.safetensors", weight: 0.8 }] });
    await render({});
    expect(frees()).toBe(1);
    await render({ checkpoint: "other.safetensors", loras: [{ file: "b.safetensors", weight: 0.8 }] });
    expect(frees()).toBe(2);
  });
});

describe("loading a model ahead of the render", () => {
  it("runs the render's graph up to one step of its first pass, makes nothing, and the render that follows keeps the model", async () => {
    expect((await post(t.app, "/api/comfy/loaded", form())).json()).toEqual({ loaded: false });
    expect((await get(t.app, "/api/queue")).json().model).toBeNull();

    // the prompt is not written yet: no reason to refuse
    const asked = await post(t.app, "/api/jobs/warm", form());
    expect(asked.statusCode).toBe(200);
    const id = asked.json().id as string;
    await until(() => submitted().length === 1);
    expect((await get(t.app, "/api/queue")).json().running).toMatchObject({ id, kind: "load", label: "Load the model: txt2img" });

    const graph = fake.prompts.get(submitted()[0]!)!;
    const classes = Object.values(graph).map((n) => n.class_type);
    expect(classes).toContain("CheckpointLoaderSimple");
    expect(classes).toContain("PreviewAny");
    expect(classes).not.toContain("VAEDecode");
    expect(classes).not.toContain("PreviewImage");
    const samplers = Object.values(graph).filter((n) => n.class_type === "KSampler");
    expect(samplers.map((n) => n.inputs.steps)).toEqual([1]);

    done(submitted()[0]!);
    await until(async () => (await statusOf(id)) === "done");
    expect(frees()).toBe(1);
    // nothing was made
    expect((await get(t.app, "/api/assets")).json().items).toEqual([]);
    expect(await t.db.selectFrom("generations").selectAll().execute()).toEqual([]);

    expect((await post(t.app, "/api/comfy/loaded", form())).json()).toEqual({ loaded: true });
    // the queue says which model that is, by its name
    expect((await get(t.app, "/api/queue")).json().model).toBe("illustrious");
    expect((await post(t.app, "/api/comfy/loaded", form({ loras: [{ file: "a.safetensors", weight: 1 }] }))).json()).toEqual({ loaded: true });
    expect((await post(t.app, "/api/comfy/loaded", form({ checkpoint: "other.safetensors" }))).json()).toEqual({ loaded: false });
    // a form too incomplete to build (a redraw with no picture yet): its chosen model alone says when the loaded one is not it, and nothing when it is
    expect((await post(t.app, "/api/comfy/loaded", { recipe: "sdxl.redraw", input: { checkpoint: "other.safetensors" } })).json()).toEqual({ loaded: false });
    expect((await post(t.app, "/api/comfy/loaded", { recipe: "sdxl.redraw", input: { checkpoint: CHECKPOINT } })).json()).toEqual({ loaded: null });

    await render({ prompt: "a dog" });
    expect(frees()).toBe(1);
    // freed by hand: no model is named any more
    await post(t.app, "/api/comfy/free");
    expect((await get(t.app, "/api/queue")).json().model).toBeNull();
    // the render ran its own steps
    const real = fake.prompts.get(submitted()[1]!)!;
    expect(Object.values(real).find((n) => n.class_type === "KSampler")!.inputs.steps).not.toBe(1);
  });

  it("tells what is loaded with the cast worked in, as the render will have it", async () => {
    // a person with pictures to follow calls for the reference model: asked without her, the answer would be about another model
    const her = (await post(t.app, "/api/entities", { kind: "person", name: "Her" })).json();
    const look = { cast: [{ id: her.id }], style: null, snippets: [] };
    const asked = await post(t.app, "/api/comfy/loaded", { ...form(), look });
    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toEqual({ loaded: false });
    const id = (await post(t.app, "/api/jobs/warm", { ...form(), look })).json().id as string;
    await until(() => submitted().length === 1);
    done(submitted()[0]!);
    await until(async () => (await statusOf(id)) === "done");
    expect((await post(t.app, "/api/comfy/loaded", { ...form(), look })).json()).toEqual({ loaded: true });
  });

  it("is stopped like any job, and says what is missing when the form cannot be built", async () => {
    const id = (await post(t.app, "/api/jobs/warm", form())).json().id as string;
    await until(() => submitted().length === 1);
    expect((await post(t.app, `/api/jobs/${id}/cancel`)).statusCode).toBe(200);
    await until(async () => (await statusOf(id)) === "cancelled");

    // a checkpoint this ComfyUI does not have
    const bad = (await post(t.app, "/api/jobs/warm", form({ checkpoint: "gone.safetensors" }))).json().id as string;
    await until(async () => (await statusOf(bad)) === "failed");
    expect((await post(t.app, "/api/comfy/loaded", { recipe: "nothing.like-it", input: {} })).json()).toEqual({ loaded: null });
  });
});
