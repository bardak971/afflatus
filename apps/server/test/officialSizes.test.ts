import { describe, expect, it, vi } from "vitest";
import type { Family } from "@afflatus/core";
import { migrate, openSqlite } from "../src/db";

const asked: string[] = [];
vi.mock("../src/fromLink", () => ({
  sizeOf: async (url: string) => {
    asked.push(url);
    return url.includes("gated") ? 0 : 7 * 2 ** 30;
  },
}));
const { OfficialSizes } = await import("../src/officialSizes");

/** Two families' official files: one Hugging Face answers for, one it refuses (a gated repository without a token). */
const families = [
  { id: "a", slots: [{ id: "m", folder: "checkpoints", get: { file: "zz-a.safetensors", url: "https://huggingface.co/zz/a/resolve/main/zz-a.safetensors" } }] },
  { id: "b", slots: [{ id: "m", folder: "checkpoints", get: { file: "zz-b.safetensors", url: "https://huggingface.co/zz/gated/resolve/main/zz-b.safetensors" } }] },
] as unknown as Family[];

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("the official files' sizes", () => {
  it("asks no site while lookups are off, and each address once while they are on", async () => {
    const db = openSqlite(":memory:");
    await migrate(db);
    let lookups = false;
    const sizes = new OfficialSizes(db, () => families, async () => lookups);
    asked.length = 0;
    expect(await sizes.sizes()).toEqual({ sizes: {}, asking: false });
    await settle();
    expect(asked).toEqual([]);

    lookups = true;
    expect((await sizes.sizes()).asking).toBe(true);
    await settle();
    expect(asked).toHaveLength(2);
    // the one found is said; the refused one is not asked again at every load, only at the next start
    expect(await sizes.sizes()).toEqual({ sizes: { "https://huggingface.co/zz/a/resolve/main/zz-a.safetensors": 7 * 2 ** 30 }, asking: false });
    await settle();
    expect(asked).toHaveLength(2);
    await db.destroy();
  });
});
