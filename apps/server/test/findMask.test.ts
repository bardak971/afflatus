import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMaskPng, makePng, startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { maskBox } from "../src/thumbs";
import { CHECKPOINT, get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * The Stage's click to mask and find (findMask.ts, card #274): a job of tools.find-mask sent ahead of the line, SAM 3's points
 * or a detector, its masks filed as working pictures with the box of what each holds; and a painted mask's box read down to
 * its faint rim, so that a mask all of soft edge still has one.
 */

const SAM = "sam3.1_multiplex_fp16.safetensors";
let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  const catalog = referenceCatalog();
  catalog.CheckpointLoaderSimple!.input.required!.ckpt_name = [[CHECKPOINT, SAM]];
  catalog.UltralyticsDetectorProvider!.input.required!.model_name = [["bbox/face_yolov8m.pt", "bbox/hand_yolov8s.pt", "segm/person_yolov8m-seg.pt"]];
  fake = await startFakeComfy({ catalog, models: { checkpoints: [CHECKPOINT, SAM], upscale_models: [], ultralytics: ["bbox/face_yolov8m.pt", "bbox/hand_yolov8s.pt", "segm/person_yolov8m-seg.pt"] } });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const upload = async () =>
  (await t.app.inject({ method: "POST", url: "/api/assets?name=zz-test%20terrace", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(200, 100, [1, 2, 3], [4, 5, 6])) })).json() as { id: string };
/** The fake ComfyUI's last prompt finished with these masks. */
const answer = (masks: Uint8Array[]) => {
  const [id, graph] = [...fake.prompts.entries()].at(-1)!;
  const out = Object.entries(graph).find(([, n]) => n.class_type === "PreviewImage")![0];
  const images = masks.map((png, i) => {
    fake.files[`${id}-${i}.png`] = png;
    return { filename: `${id}-${i}.png`, subfolder: "", type: "temp" };
  });
  fake.pending = fake.pending.filter((p) => p !== id);
  fake.history[id] = { status: { completed: true }, outputs: { [out]: { images } } };
  return graph;
};
const found = async (picture: string, job: string) => {
  await until(async () => (await get(t.app, `/api/assets/${picture}/find-mask/${job}`)).json().status === "done");
  return (await get(t.app, `/api/assets/${picture}/find-mask/${job}`)).json() as { masks: Array<{ asset: { id: string; origin: string }; box: { x: number; y: number; width: number; height: number } }> };
};

describe("find a mask", () => {
  it("from points: SAM 3's SAM3_Detect on the picture, sent ahead of the line, its mask a working picture with its box", async () => {
    const pic = await upload();
    const res = await post(t.app, `/api/assets/${pic.id}/find-mask`, { way: "points", add: [{ x: 50.4, y: 40 }, { x: 60, y: 45 }], remove: [{ x: 5, y: 5 }] });
    expect(res.statusCode, res.body).toBe(200);
    const job = res.json().job as string;
    expect((await t.db.selectFrom("jobs").select("priority").where("id", "=", job).executeTakeFirstOrThrow()).priority).toBeLessThan(-100_000);
    await until(() => fake.prompts.size === 1);
    const graph = answer([makeMaskPng(200, 100, 50, 40, 20, 10)]);
    const sam = Object.values(graph).find((n) => n.class_type === "SAM3_Detect")!;
    expect(sam.inputs).toMatchObject({ positive_coords: JSON.stringify([{ x: 50, y: 40 }, { x: 60, y: 45 }]), negative_coords: JSON.stringify([{ x: 5, y: 5 }]) });
    expect(Object.values(graph).find((n) => n.class_type === "CheckpointLoaderSimple")!.inputs.ckpt_name).toBe(SAM);
    const { masks } = await found(pic.id, job);
    expect(masks).toHaveLength(1);
    expect(masks[0]!.asset.origin).toBe("scratch");
    // the ellipse's own extent, without the room a painted mask's box gets
    expect(masks[0]!.box).toMatchObject({ x: 31, y: 31, width: 39, height: 19 });
    // a working picture: not in the library
    expect((await get(t.app, "/api/assets")).json().items.map((i: { id: string }) => i.id)).toEqual([pic.id]);
    // a find (one per click): not among the queue's last finished, which the page says "done" of (Recipe.quiet)
    expect((await get(t.app, "/api/queue")).json().recent.map((j: { id: string }) => j.id)).not.toContain(job);
  });

  it("by a detector: one mask per thing found, a mask that holds nothing left out", async () => {
    const pic = await upload();
    const job = (await post(t.app, `/api/assets/${pic.id}/find-mask`, { way: "detect", what: "hands" })).json().job as string;
    await until(() => fake.prompts.size === 1);
    const graph = answer([makeMaskPng(200, 100, 40, 60, 10, 10), makeMaskPng(200, 100, 160, 60, 10, 10), makeMaskPng(200, 100, 100, 50, 10, 10, 0)]);
    const classes = Object.values(graph).map((n) => n.class_type);
    // the node pack's CPU provider, which this ComfyUI has (card #335)
    expect(classes).toEqual(expect.arrayContaining(["AfflatusDetectorProviderCPU", "BboxDetectorSEGS", "ImpactSEGSToMaskList", "MaskToImage"]));
    expect(Object.values(graph).find((n) => n.class_type === "AfflatusDetectorProviderCPU")!.inputs.model_name).toBe("bbox/hand_yolov8s.pt");
    const { masks } = await found(pic.id, job);
    expect(masks.map((m) => m.box.x).sort((a, b) => a - b)).toEqual([31, 151]);
  });

  it("answers only a find of this picture, and refuses what is not a picture's", async () => {
    const pic = await upload();
    const other = await upload();
    const job = (await post(t.app, `/api/assets/${pic.id}/find-mask`, { way: "detect", what: "person" })).json().job as string;
    expect((await get(t.app, `/api/assets/${other.id}/find-mask/${job}`)).statusCode).toBe(404);
    expect((await post(t.app, `/api/assets/${pic.id}/find-mask`, { way: "points", add: [] })).statusCode).toBe(400);
    expect((await post(t.app, "/api/assets/nothing/find-mask", { way: "detect", what: "face" })).statusCode).toBe(404);
    // its prompt answered, so that the app closes with nothing running
    await until(() => fake.prompts.size === 1);
    answer([makeMaskPng(200, 100, 100, 50, 10, 10)]);
    expect((await found(pic.id, job)).masks).toHaveLength(1);
  });
});

describe("a find is quiet", () => {
  it("done: no notice and not among the queue's last finished; failed: said as any other", async () => {
    const notices: Array<{ kind: string }> = [];
    t.services.queue.events.on("notice", (n) => notices.push(n as { kind: string }));
    const pic = await upload();
    const done = (await post(t.app, `/api/assets/${pic.id}/find-mask`, { way: "detect", what: "face" })).json().job as string;
    await until(() => fake.prompts.size === 1);
    answer([makeMaskPng(200, 100, 100, 50, 10, 10)]);
    await found(pic.id, done);
    const failed = (await post(t.app, `/api/assets/${pic.id}/find-mask`, { way: "detect", what: "face" })).json().job as string;
    await until(() => fake.prompts.size === 2);
    const id = [...fake.prompts.keys()].at(-1)!;
    fake.pending = fake.pending.filter((p) => p !== id);
    fake.history[id] = { status: { status_str: "error", messages: [["execution_error", { exception_message: "zz-test no face detector" }]] } };
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", failed).executeTakeFirstOrThrow()).status === "failed");
    await until(() => notices.some((n) => n.kind === "renderFailed"));
    expect(notices.map((n) => n.kind)).not.toContain("renderDone");
    const recent = (await get(t.app, "/api/queue")).json().recent.map((j: { id: string }) => j.id);
    expect(recent).toContain(failed);
    expect(recent).not.toContain(done);
  });
});

describe("a painted mask's box", () => {
  it("takes in a rim painted faintly (a mask all of soft edge), and nothing below it", async () => {
    // a ring of grey 20: under the old threshold (127) the mask had no box, and the inpaint worked on the whole picture
    const faint = makeMaskPng(100, 100, 50, 50, 30, 30, 20);
    const read = await maskBox(faint);
    expect(read?.box).not.toBeNull();
    const black = makeMaskPng(100, 100, 50, 50, 30, 30, 5);
    expect((await maskBox(black))?.box).toBeNull();
  });
});
