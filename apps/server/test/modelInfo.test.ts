import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@studai/comfy/testing";
import { get, makeApp, makeFake, NOWHERE, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await makeFake();
  fake.models.loras = ["watercolour.safetensors", "Wan/motion.safetensors", "plain.safetensors", "old.pt"];
  fake.metadata["loras/watercolour.safetensors"] = { "modelspec.architecture": "stable-diffusion-xl-v1-base/lora", ss_tag_frequency: JSON.stringify({ a: { wc_style: 30, flowers: 4 } }) };
  fake.metadata["loras/Wan/motion.safetensors"] = { ss_base_model_version: "wan_2.2_14b", "modelspec.trigger_phrase": "m0tion" };
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const info = async () => (await get(t.app, "/api/models/loras/info")).json() as { items: Record<string, unknown>; pending: number };

describe("what model files say about themselves", () => {
  it("is read in the background, once, and only with read-only calls", async () => {
    // the first answer comes at once, before anything was read
    expect(await info()).toEqual({ items: {}, pending: 3 });
    await until(async () => (await info()).pending === 0);
    expect((await info()).items).toEqual({
      "watercolour.safetensors": { base: "SDXL", tags: ["wc_style", "flowers"] },
      "Wan/motion.safetensors": { base: "Wan 2.2", trigger: "m0tion" },
      // a file that says nothing is remembered as such; a file that cannot have a header is not asked about
      "plain.safetensors": {},
    });
    expect(fake.calls.every((c) => c.startsWith("GET "))).toBe(true);
    const asked = fake.calls.filter((c) => c.includes("/view_metadata/")).length;
    expect(asked).toBe(3);

    // asking again reads nothing again
    await info();
    await info();
    expect(fake.calls.filter((c) => c.includes("/view_metadata/")).length).toBe(asked);
  });

  it("reads only what is new when a file is added", async () => {
    await info();
    await until(async () => (await info()).pending === 0);
    fake.models.loras!.push("new.safetensors");
    fake.metadata["loras/new.safetensors"] = { "modelspec.title": "Brand new" };
    expect((await info()).pending).toBe(1);
    await until(async () => (await info()).pending === 0);
    expect((await info()).items["new.safetensors"]).toEqual({ title: "Brand new" });
    expect(fake.calls.filter((c) => c.includes("/view_metadata/")).length).toBe(4);
  });

  it("still answers with what it knows when ComfyUI is away", async () => {
    await info();
    await until(async () => (await info()).pending === 0);
    const away = await makeApp({ db: t.db, dir: t.dir, comfyUrl: NOWHERE });
    const res = (await get(away.app, "/api/models/loras/info")).json();
    expect(Object.keys(res.items)).toHaveLength(3);
    expect(res.pending).toBe(0);
    await away.app.close();
  });

  it("refuses a folder name that is not one", async () => {
    expect((await get(t.app, "/api/models/..%2F..%2Fetc/info")).statusCode).toBe(400);
  });
});
