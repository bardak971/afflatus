import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, type FakeComfy } from "@afflatus/comfy/testing";
import { zipNames } from "../src/zip";
import { get, makeApp, makeFake, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

describe("a backup", () => {
  it("says what it would hold, and is a zip of the database and every file, made while the app runs", async () => {
    const picture = (await t.app.inject({ method: "POST", url: "/api/assets?name=keep.png", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 96, [200, 120, 40], [40, 60, 160])) })).json() as { id: string };
    const plan = (await get(t.app, "/api/backup")).json();
    expect(plan).toMatchObject({ available: true, database: true });
    expect(plan.files).toBeGreaterThanOrEqual(1);
    expect(plan.bytes).toBeGreaterThan(0);

    const res = await get(t.app, "/api/backup.zip");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(String(res.headers["content-disposition"])).toMatch(/afflatus-backup-\d{8}-\d{4}\.zip/);
    const bytes = new Uint8Array(res.rawPayload);
    expect(bytes.subarray(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const names = zipNames(bytes);
    expect(names[0]).toBe("README.txt");
    expect(names).toContain("afflatus.db");
    expect(names.some((n) => n.startsWith("files/") && n.includes(picture.id))).toBe(true);
    // the database copy is a real SQLite file
    const at = res.rawPayload.indexOf(Buffer.from("SQLite format 3\0", "latin1"));
    expect(at).toBeGreaterThan(0);
  });
});
