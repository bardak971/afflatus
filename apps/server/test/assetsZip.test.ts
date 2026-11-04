import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { AI_COMMENT } from "../src/aiMark";
import { uniqueNames, zipName } from "../src/assetsZip";
import { get, makeApp, post } from "./helpers";

/** A library selection downloaded as one zip (assetsZip.ts): asked by ids, followed as a link, streamed. */

const picture = (r: number) => sharp({ create: { width: 6, height: 4, channels: 3, background: { r, g: 40, b: 10 } } }).png().toBuffer();

describe("the names in a selection's zip", () => {
  it("are the item's own with its extension, the same name twice numbered as a file manager does", () => {
    expect(zipName({ id: "abc", name: "", mime: "image/png" })).toBe("abc.png");
    expect(zipName({ id: "abc", name: "cat: 0:05", mime: "video/mp4" })).toBe("cat. 0.05.mp4");
    expect(zipName({ id: "abc", name: "done.PNG", mime: "image/png" })).toBe("done.PNG");
    expect(uniqueNames(["a.png", "b.png", "A.png", "a.png", "x"])).toEqual(["a.png", "b.png", "A (2).png", "a (3).png", "x"]);
  });
});

describe("a selection downloaded as a zip", () => {
  it("holds every item in the order asked, renders marked, and its address works once", async () => {
    const t = await makeApp();
    try {
      const upload = async (name: string, r: number) => (await t.app.inject({ method: "POST", url: `/api/assets?name=${name}`, headers: { "content-type": "image/png" }, payload: await picture(r) })).json() as { id: string };
      const one = await upload("same", 10);
      const two = await upload("same", 20);
      const made = await upload("render", 30);
      await t.db.updateTable("assets").set({ origin: "generated" }).where("id", "=", made.id).execute();

      const asked = await post(t.app, "/api/assets/zip", { ids: [made.id, one.id, two.id, "gone"] });
      expect(asked.statusCode).toBe(200);
      const { href } = asked.json() as { href: string };
      const zip = await get(t.app, href);
      expect(zip.statusCode).toBe(200);
      expect(zip.headers["content-type"]).toBe("application/zip");
      expect(String(zip.headers["content-disposition"])).toMatch(/^attachment; filename="afflatus-3-items-/);
      const body = zip.rawPayload.toString("latin1");
      // each entry's name is in its local header and again in the central directory, in the order asked
      const at = (n: string) => body.indexOf(n);
      expect(at("render.png")).toBeGreaterThanOrEqual(0);
      expect(at("render.png")).toBeLessThan(at("same.png"));
      expect(at("same.png")).toBeLessThan(at("same (2).png"));
      // only the render is marked as made by a model, and goes in as its own Download gives it, byte for byte (stored as it is)
      expect(body.split(AI_COMMENT).length - 1).toBe(1);
      const single = (await get(t.app, `/api/assets/${made.id}/file?download=1`)).rawPayload;
      expect(zip.rawPayload.includes(single)).toBe(true);
      // the end of central directory record says three entries
      const end = zip.rawPayload.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      expect(zip.rawPayload.readUInt16LE(end + 10)).toBe(3);

      // followed once: the same address again, or one never given, is refused
      expect((await get(t.app, href)).statusCode).toBe(404);
      expect((await get(t.app, "/api/assets/zip/nothing")).statusCode).toBe(404);
      // nothing asked, nothing given
      expect((await post(t.app, "/api/assets/zip", { ids: [] })).statusCode).toBe(400);
      const none = (await post(t.app, "/api/assets/zip", { ids: ["gone"] })).json() as { href: string };
      expect((await get(t.app, none.href)).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});
