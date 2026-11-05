import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { useAssets } from "../../src/data";
import { useEveryPage } from "../../src/grid/everyPage";
import { useBanners } from "../../src/store";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

/**
 * The grid board's pages (card #325): every page of the grid's items is read, but a page that fails is asked for again a
 * few times only, then said once, rather than asked without end while the server is down.
 */

const item = (id: string) => ({
  id, kind: "image", origin: "generated", name: `zz-test ${id}`, mime: "image/png", bytes: 1, width: 8, height: 8, durationMs: null, fps: null,
  hasSound: false, kept: false, inBin: false, folderId: null, generationId: null, createdAt: "2026-11-05T12:00:00.000Z", path: null,
});
function Board() {
  const list = useAssets({ grid: "g1", limit: 200 }, true);
  useEveryPage(list, { id: "grid-pages:g1", href: "/", go: "Open the Studio" }, "Some cells of the grid could not be read", 5);
  return <ul>{list.data?.pages.flatMap((p) => p.items).map((a) => <li key={a.id}>{a.name}</li>)}</ul>;
}
const second = () => fakeApi.calls("GET", "/assets?").filter((c) => c.path.includes("after=")).length;
const wait = (ms: number) => act(() => new Promise((done) => setTimeout(done, ms)));

describe("the grid board's pages", () => {
  it("asks a failed page again a few times, then says it once and stops asking", async () => {
    fakeApi.on("GET /assets", () => {
      const after = new URLSearchParams(fakeApi.calls("GET", "/assets?").at(-1)!.path.split("?")[1]).get("after");
      return after ? jsonAnswer({ error: "the server is down" }, 503) : { items: [item("a")], next: "1", prev: null };
    });
    draw(<Board />);
    await screen.findByText("zz-test a");
    // the first ask and three more, each after a longer wait (5, 10, 20 ms here)
    await waitFor(() => expect(useBanners.getState().items.map((b) => b.title)).toContain("Some cells of the grid could not be read"));
    expect(second()).toBe(4);
    await wait(150);
    expect(second()).toBe(4);
    expect(useBanners.getState().items.filter((b) => b.id?.startsWith("grid-pages"))).toHaveLength(1);
  });

  it("reads the page once the server answers again within its tries", async () => {
    let fails = 2;
    fakeApi.on("GET /assets", () => {
      const after = new URLSearchParams(fakeApi.calls("GET", "/assets?").at(-1)!.path.split("?")[1]).get("after");
      if (!after) return { items: [item("a")], next: "1", prev: null };
      return fails-- > 0 ? jsonAnswer({ error: "the server is down" }, 503) : { items: [item("b")], next: null, prev: null };
    });
    draw(<Board />);
    await screen.findByText("zz-test b");
    expect(second()).toBe(3);
    expect(useBanners.getState().items.filter((b) => b.id?.startsWith("grid-pages"))).toHaveLength(0);
  });
});
