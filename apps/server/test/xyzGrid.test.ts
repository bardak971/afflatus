import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { CHECKPOINT, get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";
import { mcpClient } from "./mcpClient";

/** X/Y/Z grids (card #21): one job per cell through the queue, tagged; the cells on the board; a page as a labelled sheet. */
const recipe = "sdxl.text-to-picture";
const input = { prompt: "a lighthouse in a red coat of paint, dusk", checkpoint: CHECKPOINT, steps: 30, cfg: 5, seed: -1 };

/** The fake finishing a prompt with a real (small) picture, which the sheet can read; or failing it as ComfyUI does. */
async function finish(fake: FakeComfy, id: string, fail = false) {
  const graph = fake.prompts.get(id)!;
  const out = Object.entries(graph).find(([, n]) => n.class_type === "PreviewImage")![0];
  fake.pending = fake.pending.filter((p) => p !== id);
  if (fail) {
    const error = { prompt_id: id, node_id: out, node_type: "PreviewImage", executed: [], exception_message: "out of memory", exception_type: "RuntimeError", traceback: [], current_inputs: {}, current_outputs: {} };
    fake.history[id] = { status: { status_str: "error", completed: false, messages: [["execution_error", error]] } };
    return;
  }
  fake.files[`${id}.png`] = new Uint8Array(await sharp({ create: { width: 64, height: 96, channels: 3, background: "#808080" } }).png().toBuffer());
  fake.history[id] = { status: { completed: true }, outputs: { [out]: { images: [{ filename: `${id}.png`, subfolder: "", type: "temp" }] } } };
}

/** The samplers of a graph a prompt was sent with: what the cell renders. */
const sampled = (fake: FakeComfy, id: string) => Object.values(fake.prompts.get(id)!).find((n) => n.class_type === "KSampler")!.inputs as Record<string, unknown>;

describe("an X/Y/Z grid", () => {
  let fake: FakeComfy;
  let t: TestApp;
  beforeEach(async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], upscale_models: [] } });
    t = await makeApp({ comfyUrl: fake.url });
    await t.services.queue.start();
  });
  afterEach(async () => {
    await t.close();
    await fake.close().catch(() => {});
  });

  it("queues one job per cell, tagged with the grid and its place, on one seed; a failed cell fails alone; the cells carry their place", async () => {
    const draft = (await post(t.app, "/api/drafts", { recipe, forms: { [recipe]: { prompt: input.prompt } } })).json();
    const res = await post(t.app, "/api/grids", { recipe, input, draft: draft.id, axes: [{ field: "cfg", values: "4, 6" }, { field: "steps", values: "20-30 (+10)" }] });
    expect(res.statusCode).toBe(200);
    const grid = res.json() as { id: string; count: number; jobs: string[] };
    expect(grid.count).toBe(4);
    const jobs = await t.db.selectFrom("jobs").select(["id", "grid_id", "grid_cell", "label", "inputs"]).where("grid_id", "=", grid.id).orderBy("created_at").execute();
    expect(jobs.map((j) => j.grid_cell)).toEqual(["0.0.0", "1.0.0", "0.1.0", "1.1.0"]);
    expect(jobs.map((j) => JSON.parse(j.inputs) as Record<string, unknown>).map((i) => [i.cfg, i.steps])).toEqual([[4, 20], [6, 20], [4, 30], [6, 30]]);
    // the form's random seed drawn once for the whole grid: the cells differ by their axes alone
    expect(new Set(jobs.map((j) => (JSON.parse(j.inputs) as { seed: number }).seed)).size).toBe(1);
    expect(jobs[1]!.label).toMatch(/· 6 · 20$/);

    // each cell rendered as its own prompt; the third fails, the others land
    for (let k = 0; k < 4; k++) {
      await until(() => fake.prompts.size === k + 1);
      const id = [...fake.prompts.keys()].at(-1)!;
      expect(sampled(fake, id).cfg).toBe([4, 6, 4, 6][k]);
      await finish(fake, id, k === 2);
    }
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("grid_id", "=", grid.id).where("status", "in", ["done", "failed"]).execute()).length === 4);
    const view = (await get(t.app, `/api/grids/${grid.id}`)).json() as { axes: Array<{ label: string; labels: string[] }>; jobs: Record<string, { status: string }>; draftId: string };
    expect(view.axes).toEqual([{ field: "cfg", label: "CFG scale", labels: ["4", "6"] }, { field: "steps", label: "Steps", labels: ["20", "30"] }]);
    expect(Object.fromEntries(Object.entries(view.jobs).map(([c, j]) => [c, j.status]))).toEqual({ "0.0.0": "done", "1.0.0": "done", "0.1.0": "failed", "1.1.0": "done" });
    expect(view.draftId).toBe(draft.id);

    // the board's cells: the library's items of the grid, each with its place, unkept as any render
    const items = (await get(t.app, `/api/assets?grid=${grid.id}`)).json().items as Array<{ grid: { x: number; y: number; z: number }; kept: boolean; draftOf: { id: string } }>;
    expect(items.map((a) => `${a.grid.x}.${a.grid.y}.${a.grid.z}`).sort()).toEqual(["0.0.0", "1.0.0", "1.1.0"]);
    expect(items.every((a) => !a.kept && a.draftOf.id === draft.id)).toBe(true);
    expect((await get(t.app, `/api/grids?draft=${draft.id}`)).json().items).toEqual([expect.objectContaining({ id: grid.id, axes: ["CFG scale", "Steps"], count: 4 })]);

    // a page as one labelled sheet: a new picture beside the cells, kept; the failed cell left blank
    const sheet = await post(t.app, `/api/grids/${grid.id}/sheet`, { z: 0 });
    expect(sheet.statusCode).toBe(200);
    expect(sheet.json()).toMatchObject({ kind: "image", origin: "edited", kept: true, name: "Grid · CFG scale × Steps" });
    const { width, height } = sheet.json() as { width: number; height: number };
    expect(width).toBeGreaterThan(2 * 64);
    expect(height).toBeGreaterThan(2 * 96);
    expect((await get(t.app, `/api/assets?grid=${grid.id}`)).json().items).toHaveLength(3);
  });

});

describe("an X/Y/Z grid, as it is queued", () => {
  // the queue not started: what is queued waits, and is read as it was sent
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(() => t.close());

  it("refuses a grid it cannot read, queuing nothing and keeping no grid", async () => {
    const res = await post(t.app, "/api/grids", { recipe, input, axes: [{ field: "cfg", values: "4, 6" }, { field: "sr", values: "blue coat, green coat" }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^Y: “blue coat” is not in the prompt/);
    expect(await t.db.selectFrom("jobs").select("id").execute()).toEqual([]);
    expect(await t.db.selectFrom("grids").select("id").execute()).toEqual([]);
  });

  it("puts each Prompt S/R value in place of the first", async () => {
    const res = (await post(t.app, "/api/grids", { recipe, input, axes: [{ field: "sr", values: "red coat, blue coat" }, { field: "seed", values: "1, 2" }] })).json() as { id: string };
    const jobs = await t.db.selectFrom("jobs").select(["inputs", "grid_cell"]).where("grid_id", "=", res.id).orderBy("created_at").execute();
    expect(jobs.map((j) => JSON.parse(j.inputs) as { prompt: string; seed: number }).map((i) => [i.prompt.match(/a (\w+) coat/)?.[1], i.seed])).toEqual([["red", 1], ["blue", 1], ["red", 2], ["blue", 2]]);
  });

  it("a draft keeps its grid's set-up to open on again; an empty one is none", async () => {
    const draft = (await post(t.app, "/api/drafts", { recipe })).json();
    const axes = [{ field: "steps", values: "20, 30" }, { field: "sr", values: "red coat, blue coat" }];
    const put = (grid: unknown) => t.app.inject({ method: "PUT", url: `/api/drafts/${draft.id}`, payload: { forms: { [recipe]: { prompt: input.prompt } }, grid } });
    expect((await put({ axes })).json().grid).toEqual({ axes });
    expect((await get(t.app, `/api/drafts/${draft.id}`)).json().grid).toEqual({ axes });
    expect((await put({ axes: [] })).json().grid).toBeNull();
  });

  it("MCP's render_grid queues a draft's own grid, each cell counted against the token's renders an hour", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const draft = (await post(t.app, "/api/drafts", { recipe, forms: { [recipe]: { prompt: input.prompt, checkpoint: CHECKPOINT } } })).json();
    await t.app.inject({ method: "PUT", url: `/api/drafts/${draft.id}`, payload: { grid: { axes: [{ field: "cfg", values: "4, 6" }, { field: "sr", values: "red coat, blue coat" }] } } });
    const made = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: "zz-test grid", start: "make" } });
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const c = await mcpClient(`http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/mcp`, made.json().token as string);
    try {
      const r = await c.callTool({ name: "render_grid", arguments: { draft: draft.id } });
      expect(r.isError).toBeFalsy();
      const answer = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { grid: string; jobs: string[]; count: number };
      expect(answer).toMatchObject({ count: 4, jobs: expect.any(Array) });
      const jobs = await t.db.selectFrom("jobs").select(["grid_cell", "mcp_token_id"]).where("grid_id", "=", answer.grid).execute();
      expect(jobs).toHaveLength(4);
      expect(new Set(jobs.map((j) => j.mcp_token_id)).size).toBe(1);
      expect(jobs[0]!.mcp_token_id).toBeTruthy();
      // axes it cannot read: refused, nothing more queued
      const bad = await c.callTool({ name: "render_grid", arguments: { draft: draft.id, axes: [{ field: "sr", values: "green coat, blue coat" }] } });
      expect(bad.isError).toBe(true);
      expect(await t.db.selectFrom("jobs").select("id").execute()).toHaveLength(4);
    } finally {
      await c.close();
    }
  });
});
