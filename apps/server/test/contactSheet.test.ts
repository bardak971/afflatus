import { describe, expect, it } from "vitest";
import { makePng } from "@afflatus/comfy/testing";
import { contactSheet, readPicture } from "../src/thumbs";

/**
 * A contact sheet (MCP's compare and view_timeline) holds each picture to 4 × its height in width: a very wide one (a
 * 65000×16 PNG brought to a 512 px row was ~268 Mpx in memory) is shrunk to fit, the row's height kept.
 */
describe("a contact sheet", () => {
  it("holds a very wide picture to 4 × the row's height, beside a plain one", async () => {
    const sheet = await contactSheet([
      { bytes: makePng(65000, 16, [200, 10, 10], [10, 10, 200]), label: "1" },
      { bytes: makePng(64, 64, [9, 9, 9], [200, 200, 200]), label: "2" },
    ], { height: 512, perRow: 2 });
    expect(sheet).not.toBeNull();
    const read = await readPicture(sheet!);
    expect(read).toMatchObject({ width: 4 * 512 + 8 + 512, height: 512 });
  });
});
