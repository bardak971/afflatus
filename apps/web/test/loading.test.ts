import { describe, expect, it } from "vitest";
import { THUMB_SIZES, thumbSrcSet, thumbUrl } from "../src/api";
import { chunkFor, loadPeople, loadQueue, loadSetup, loadTimelineEditor, loadWorkflows } from "../src/lazyParts";

describe("a tile's thumbnail", () => {
  it("offers the 256 px and the 512 px sizes of a thumbnail, and nothing for another address", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(thumbSrcSet(thumbUrl(id))).toBe(`/api/assets/${id}/thumb?w=256 256w, /api/assets/${id}/thumb 512w`);
    expect(thumbSrcSet(`/api/assets/${id}/file`)).toBeUndefined();
    expect(thumbSrcSet(`/api/assets/${id}/thumb?w=256`)).toBeUndefined();
    expect(thumbSrcSet("blob:http://127.0.0.1/x")).toBeUndefined();
  });

  it("outside a grid that says its width, is picked for the widest tile (the 512 px one at one pixel per point), never by sizes=auto", () => {
    // Chrome keeps every <img sizes="auto"> it laid out as a listener of the viewport: a grid whose tiles are replaced leaked
    // them (the grid's own width: Thumb.tsx ThumbWidth, test/dom/lists.dom.test.tsx)
    expect(THUMB_SIZES).not.toContain("auto");
    expect(Number.parseInt(THUMB_SIZES, 10)).toBeGreaterThan(256);
  });
});

describe("a screen's code fetched before it is opened", () => {
  it("is the chunk of the screen a link leads to", () => {
    expect(chunkFor("/queue")).toBe(loadQueue);
    expect(chunkFor("/settings")).toBe(loadSetup);
    expect(chunkFor("/settings/storage")).toBe(loadSetup);
    expect(chunkFor("/kit")).toBe(loadPeople);
    expect(chunkFor("/workflows")).toBe(loadWorkflows);
    expect(chunkFor("/workflows/abc/edit")).toBe(loadWorkflows);
    expect(chunkFor("/timelines/0123456789abcdef0123456789abcdef")).toBe(loadTimelineEditor);
  });

  it("is none for the Studio's own addresses and for anything else", () => {
    for (const href of ["/", "/create", "/timelines", "/timelines/", "/queueish", "https://example.com/queue", "#x", ""]) expect(chunkFor(href)).toBeNull();
  });
});
