import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeRecipe, refusalOf } from "@afflatus/core";
import { recipeById } from "@afflatus/recipes";
import { newId, now, OWNER } from "../src/db";
import { newAssetRow } from "../src/media";
import { makeApp, post, type TestApp } from "./helpers";
import { mcpClient } from "./mcpClient";

/**
 * Krea 2 cannot take a person reference with style reference images (card #219): refused before it is queued, by the form's
 * Render, a cast person and MCP's render alike. Refused only at its build on the machine, the job was accepted, waited for
 * or booted a pod, and failed there.
 */
const RECIPE = "krea2.text-to-picture";
let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

async function picture(name: string): Promise<string> {
  const id = newId();
  await t.db.insertInto("assets").values(newAssetRow({ id, kind: "image", origin: "uploaded", name, file_key: `assets/zz/${id}`, thumb_key: null, mime: "image/png", bytes: 1, width: 512, height: 512, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: now() })).execute();
  return id;
}
const jobs = async () => (await t.db.selectFrom("jobs").select("id").execute()).length;

describe("Krea 2 with a person reference and style reference images", () => {
  it("is refused before it is queued, in the words the form says it", async () => {
    const style = { asset: await picture("zz-test style.png"), role: "style" };
    const person = { asset: await picture("zz-test face.png"), role: "person" };
    const res = await post(t.app, "/api/jobs", { recipe: RECIPE, input: { prompt: "zz-test on a terrace", person: [person], references: [style] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^Krea 2 takes a person reference or style reference images, not both/);
    expect(await jobs()).toBe(0);
    // the form reads the same refusal (GET /api/recipes): Render greyed with it
    const recipe = recipeById(RECIPE)!;
    expect(refusalOf(describeRecipe(recipe), { person: [person], references: [style] })).toBe(res.json().error);
    expect(refusalOf(describeRecipe(recipe), { person: [person], references: [] })).toBeNull();
    // either one alone is queued
    expect((await post(t.app, "/api/jobs", { recipe: RECIPE, input: { prompt: "zz-test on a terrace", person: [person] } })).statusCode).toBe(200);
    expect((await post(t.app, "/api/jobs", { recipe: RECIPE, input: { prompt: "zz-test on a terrace", references: [style] } })).statusCode).toBe(200);
  });

  it("is refused when a cast person fills the person reference", async () => {
    const style = { asset: await picture("zz-test style.png"), role: "style" };
    const id = newId();
    await t.db.insertInto("entities").values({ id, owner_id: OWNER, kind: "person", name: "zz-test Mara", def: JSON.stringify({ pictures: [await picture("zz-test face.png")], sentence: "zz-test" }), created_at: now(), updated_at: now() }).execute();
    const res = await post(t.app, "/api/jobs", { recipe: RECIPE, input: { prompt: "zz-test on a terrace", references: [style] }, look: { cast: [{ id }], snippets: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not both/);
    expect(await jobs()).toBe(0);
  });

  it("is refused by MCP's render, nothing queued", async () => {
    const style = { asset: await picture("zz-test style.png"), role: "style" };
    const person = { asset: await picture("zz-test face.png"), role: "person" };
    const made = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: "zz-test krea", start: "make" } });
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const c = await mcpClient(`http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/mcp`, made.json().token as string);
    try {
      const r = await c.callTool({ name: "render", arguments: { form: RECIPE, values: { prompt: "zz-test on a terrace", person: [person], references: [style] } } });
      expect(r.isError).toBe(true);
      expect((r.content as Array<{ text: string }>)[0]!.text).toMatch(/not both/);
      expect(await jobs()).toBe(0);
    } finally {
      await c.close();
    }
  });
});
