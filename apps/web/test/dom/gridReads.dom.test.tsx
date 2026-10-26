import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { changeAssets } from "../../src/assetChange";
import { useAssets } from "../../src/data";
import { useLiveEvents } from "../../src/live";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The Studio grid after a bin, a put back or a move made in this tab (P2): the grid holds every page scrolled through, and
 * reading them all again, twice (once the change is done, then on the server's event of it), was some hundred requests for
 * one Delete. What the change made shows in place: it is not read again, unless an item comes into it.
 */

/** The server's event stream, as the test sends its events. */
class FakeSource {
  static last: FakeSource | null = null;
  static readonly CLOSED = 2;
  readyState = 1;
  private heard = new Map<string, Array<(e: MessageEvent<string>) => void>>();
  constructor() {
    FakeSource.last = this;
  }
  addEventListener(name: string, on: (e: MessageEvent<string>) => void) {
    this.heard.set(name, [...(this.heard.get(name) ?? []), on]);
  }
  close() {
    this.readyState = 2;
  }
  send(name: string, data: unknown) {
    for (const on of this.heard.get(name) ?? []) on(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}
beforeEach(() => vi.stubGlobal("EventSource", FakeSource));
afterEach(() => vi.unstubAllGlobals());

const PAGES = 5;
const item = (page: number, i: number) => ({
  id: `zz-${page}-${i}`, kind: "image", origin: "generated", name: `zz-test ${page}-${i}`, mime: "image/png", bytes: 1, width: 8, height: 8, durationMs: null, fps: null,
  hasSound: false, kept: true, inBin: false, folderId: null, generationId: null, createdAt: new Date(Date.UTC(2026, 9, 26, 12, 0, -(page * 3 + i))).toISOString(), path: null,
});
/** The library: five pages of three; `binned` left out of them. */
function serve(binned: Set<string>) {
  fakeApi.on("GET /assets", () => {
    const query = new URLSearchParams(fakeApi.calls("GET", "/assets?").at(-1)!.path.split("?")[1]);
    if (query.get("bin")) return { items: [], next: null, prev: null };
    const page = Number(query.get("after") ?? 0);
    return { items: [0, 1, 2].map((i) => item(page, i)).filter((a) => !binned.has(a.id)), next: page + 1 < PAGES ? String(page + 1) : null, prev: null };
  });
  fakeApi.on("POST /drafts/using", { drafts: [] });
  fakeApi.on("DELETE /assets/:id", ({ params }) => {
    binned.add(params.id!);
    return { ok: true };
  });
}

/** The Studio grid as it reads the library: uncapped, every page scrolled through kept. */
function Grid() {
  useLiveEvents();
  const assets = useAssets({}, true, false);
  return (
    <>
      <ul>{assets.data?.pages.flatMap((p) => p.items).map((a) => <li key={a.id}>{a.name}</li>)}</ul>
      {assets.hasNextPage && <button type="button" onClick={() => void assets.fetchNextPage()}>More</button>}
    </>
  );
}
const listReads = () => fakeApi.calls("GET", "/assets?").filter((c) => !c.path.includes("bin=1")).length;

async function scrolled() {
  const binned = new Set<string>();
  serve(binned);
  const { user, client } = draw(<Grid />);
  for (let p = 1; p < PAGES; p++) await user.click(await screen.findByRole("button", { name: "More" }));
  await screen.findByText(`zz-test ${PAGES - 1}-2`);
  expect(listReads()).toBe(PAGES);
  return { client, binned };
}
const wait = (ms: number) => act(() => new Promise((done) => setTimeout(done, ms)));

describe("the Studio grid after a change made in this tab", () => {
  it("is not read again page by page after a bin, nor once more on the server's event of it", async () => {
    const { client } = await scrolled();
    await act(() => changeAssets(client, { kind: "bin", ids: ["zz-2-1"] }));
    await waitFor(() => expect(screen.queryByText("zz-test 2-1")).toBeNull());
    FakeSource.last!.send("library", { change: "binned", items: ["zz-2-1"], folders: [null] });
    await wait(1500);
    expect(listReads()).toBe(PAGES);
    expect(screen.getByText("zz-test 4-2")).toBeTruthy();
  });

  it("is read again on the event of a change made elsewhere", async () => {
    const { binned } = await scrolled();
    binned.add("zz-3-0");
    FakeSource.last!.send("library", { change: "binned", items: ["zz-3-0"], folders: [null] });
    await waitFor(() => expect(screen.queryByText("zz-test 3-0")).toBeNull());
    expect(listReads()).toBe(PAGES * 2);
  });

  it("is read again after a put back, which brings an item into it", async () => {
    const { client } = await scrolled();
    fakeApi.on("POST /assets/:id/restore", () => item(9, 9));
    // the item is in no copy on screen: where it comes in is the server's to say
    await act(() => changeAssets(client, { kind: "restore", ids: ["zz-9-9"] }));
    await waitFor(() => expect(listReads()).toBe(PAGES * 2));
  });
});
