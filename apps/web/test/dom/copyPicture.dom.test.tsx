import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Asset } from "../../src/api";
import { useItemMutations } from "../../src/itemMutations";
import { canCopyPicture, copyPicture } from "../../src/secureContext";
import { useBanners } from "../../src/store";
import type { ViewerActions } from "../../src/viewer/useViewerActions";
import { ViewerMedia } from "../../src/viewer/ViewerMedia";
import { Viewer } from "../../src/Viewer";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** The clipboard as Chrome gives a secure page: what was written is kept, each type's blob still to come. */
const written: Array<Record<string, Promise<Blob>>> = [];
class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

/**
 * The clipboard the page reaches, written to as Chrome does: each blob waited for, the first that does not come failing
 * the write. Put back after a drawing, as user-event (draw) puts its own on the navigator.
 */
function fakeClipboard() {
  const write = async (items: FakeClipboardItem[]) => {
    await Promise.all(items.flatMap((i) => Object.values(i.items)));
    written.push(...items.map((i) => i.items));
  };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(), write } });
}

beforeEach(() => {
  written.length = 0;
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  vi.stubGlobal("isSecureContext", true);
  fakeClipboard();
});
afterEach(() => vi.unstubAllGlobals());

const png = () => new Response(new Blob(["zz-test png"], { type: "image/png" }), { headers: { "Content-Type": "image/png" } });
const picture = { id: "zz-test-pic", name: "zz-test picture", kind: "image", mime: "image/png" } as unknown as Asset;

describe("a picture on the clipboard", () => {
  it("is put there as a PNG, the file as it is", async () => {
    fakeApi.on("GET /assets/:id/file", png);
    await copyPicture("/api/assets/zz-test-pic/file");
    expect(written).toHaveLength(1);
    expect(Object.keys(written[0]!)).toEqual(["image/png"]);
    const blob = await written[0]!["image/png"]!;
    expect(blob.type).toBe("image/png");
    expect(await blob.text()).toBe("zz-test png");
  });

  it("fails when the file does not come", async () => {
    await expect(copyPicture("/api/assets/zz-test-gone/file")).rejects.toThrow("the picture did not come (404)");
  });

  it("is not offered on a page that is not secure (its LAN address over http), nor without the clipboard's write", () => {
    expect(canCopyPicture()).toBe(true);
    vi.stubGlobal("isSecureContext", false);
    expect(canCopyPicture()).toBe(false);
    vi.stubGlobal("isSecureContext", true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    expect(canCopyPicture()).toBe(false);
  });

  it("is said in a banner once copied, and the failure too", async () => {
    let m!: ReturnType<typeof useItemMutations>;
    function Probe() {
      m = useItemMutations();
      return null;
    }
    draw(<Probe />);
    fakeClipboard();
    fakeApi.on("GET /assets/:id/file", ({ params }) => (params.id === "zz-test-pic" ? png() : new Response("", { status: 404 })));
    act(() => m.copyImage(picture));
    await waitFor(() => expect(useBanners.getState().items.map((b) => b.title)).toContain("Picture copied"));
    act(() => m.copyImage({ id: "zz-test-gone" }));
    await waitFor(() => expect(useBanners.getState().items.map((b) => b.title)).toContain("Could not copy the picture"));
  });
});

describe("the viewer over the screen", () => {
  const acts = { a: picture } as unknown as ViewerActions;
  const media = (more: { onCopy?(): void; onClose?(): void }) => (
    <ViewerMedia acts={acts} player={{ current: null }} trim={false} onTrim={() => {}} trimRange={null} onTrimRange={() => {}} onMenu={() => {}} overlay {...more} />
  );

  it("copies the picture on a click on it, and closes on a click beside it", () => {
    const onCopy = vi.fn();
    const onClose = vi.fn();
    draw(media({ onCopy, onClose }));
    const img = screen.getByRole("img");
    expect(img.getAttribute("data-tip")).toBe("Click to copy the picture (Ctrl+C)");
    fireEvent.click(img);
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(img.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says nothing of a copy where the page cannot make one", () => {
    const onClose = vi.fn();
    draw(media({ onClose }));
    const img = screen.getByRole("img");
    expect(img.hasAttribute("data-tip")).toBe(false);
    fireEvent.click(img);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Ctrl+C in the viewer", () => {
  it("copies once while the key is held, not once a repeat with a banner each", async () => {
    fakeApi.on("GET /assets/:id/file", png);
    draw(<Viewer asset={picture} items={[picture]} onOpen={() => {}} onClose={() => {}} />);
    fakeClipboard();
    const held = { key: "c", ctrlKey: true };
    fireEvent.keyDown(window, held);
    fireEvent.keyDown(window, { ...held, repeat: true });
    fireEvent.keyDown(window, { ...held, repeat: true });
    await waitFor(() => expect(written).toHaveLength(1));
    await act(() => new Promise((done) => setTimeout(done, 50)));
    expect(written).toHaveLength(1);
    expect(useBanners.getState().items.filter((b) => b.title === "Picture copied")).toHaveLength(1);
  });
});
