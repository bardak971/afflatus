import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scan } from "@afflatus/comfy";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { CHECKPOINT, makeApp, makeFake, until, type TestApp } from "./helpers";

/**
 * The machine check (Comfy.scan) past its minute: the queue, the setup page and /metrics are answered from the last one
 * while the next is made, and the node list (several MB) is not fetched again for it (perf review 2026-10-15, H-1: with
 * several machines, /api/queue took 1.4 s and blocked the server up to 5 s each minute).
 */

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await t.close();
  await fake.close().catch(() => {});
});

const checkpoints = (s: Scan) => s.recipes.find((r) => r.id === "sdxl.text-to-picture")!.options.checkpoint ?? [];
const nodeLists = () => fake.calls.filter((c) => c === "GET /object_info").length;

describe("the machine check", () => {
  it("answers the last scan while the next one is made, with the node list kept", async () => {
    const comfy = await t.services.comfy();
    const first = await comfy.scan();
    expect(checkpoints(first)).toContain(CHECKPOINT);
    const lists = nodeLists();
    fake.models.checkpoints!.push("zz-test-new.safetensors");
    // the model folders do not answer until let through: a check waited on would hold the caller as long
    let open!: () => void;
    const gate = new Promise<void>((go) => (open = go));
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith(`${fake.url}/models/`)) await gate;
      return real(input, init);
    });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
    const answered = await Promise.race([comfy.scan(), new Promise((go) => setTimeout(() => go("waited"), 2_000))]);
    expect(answered).toBe(first);
    vi.useRealTimers();
    open();
    // the new one, once made, is the answer: the file that came is listed
    await until(async () => checkpoints(await comfy.scan()).includes("zz-test-new.safetensors"));
    expect(nodeLists()).toBe(lists);
  });

  it("waits for a check asked afresh, which reads the node list again", async () => {
    const comfy = await t.services.comfy();
    await comfy.scan();
    const lists = nodeLists();
    fake.models.checkpoints!.push("zz-test-new.safetensors");
    expect(checkpoints(await comfy.scan(true))).toContain("zz-test-new.safetensors");
    expect(nodeLists()).toBe(lists + 1);
  });
});
