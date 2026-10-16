import { describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { Asset } from "../../src/api";
import type { LibraryChange } from "../../src/queryKeys";
import { useBanners } from "../../src/store";
import { useMediaExtract } from "../../src/viewer/useMediaExtract";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

// the library's events as the server sends them: heard here, said by the test
const heard = new Set<(c: LibraryChange) => void>();
vi.mock("../../src/live", async (real) => ({
  ...(await real<typeof import("../../src/live")>()),
  hearLibrary: (fn: (c: LibraryChange) => void) => {
    heard.add(fn);
    return () => void heard.delete(fn);
  },
}));
const say = (c: LibraryChange) => heard.forEach((fn) => fn(c));

const video = (id: string) => ({ id, name: `zz-test ${id}`, kind: "video", mime: "video/mp4", fps: 24, durationMs: 10_000 }) as unknown as Asset;
const A = video("zz-test-a");
const B = video("zz-test-b");

/** The viewer's media actions on the item shown, which the test steps to another one (the arrows). */
function rig() {
  const onOpened = vi.fn();
  let m!: ReturnType<typeof useMediaExtract>;
  let show!: (a: Asset) => void;
  function Viewer() {
    const [asset, setAsset] = useState(A);
    show = setAsset;
    m = useMediaExtract({ asset, trim: false, player: { current: null }, onOpened });
    return null;
  }
  draw(<Viewer />);
  return { m: () => m, show: (a: Asset) => act(() => show(a)), onOpened };
}

/** A's split queued, and its range landing as a new video of A's. */
async function splitA(m: () => ReturnType<typeof useMediaExtract>) {
  fakeApi.on("POST /assets/:id/range", { id: "zz-test-job" });
  fakeApi.on("GET /assets/:id", ({ params }) => ({ ...video(params.id!), source: { asset: { id: A.id }, range: { startMs: 1000, endMs: 2000 } } }));
  act(() => m().cutRange.mutate({ range: { startMs: 1000, endMs: 2000 }, action: "split", crf: 10 }));
  await waitFor(() => expect(m().cutRange.isSuccess).toBe(true));
}

describe("the viewer's cuts, drawn", () => {
  it("goes on to the range split out once it lands, while the item split is still shown", async () => {
    const { m, onOpened } = rig();
    await splitA(m);
    say({ change: "added", items: ["zz-test-piece"] } as LibraryChange);
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(expect.objectContaining({ id: "zz-test-piece" })));
  });

  it("stays on the item stepped to with the arrows when the pieces of the one before land (W-6)", async () => {
    const { m, show, onOpened } = rig();
    await splitA(m);
    show(B);
    say({ change: "added", items: ["zz-test-piece"] } as LibraryChange);
    // (what lands is read, then followed or not: given its moment)
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(onOpened).not.toHaveBeenCalled();
    expect(heard.size).toBe(0);
  });

  it("says every shot copied out as queued, and why it was not (W-2)", async () => {
    fakeApi.on("POST /assets/:id/range", { id: "zz-test-job" });
    const { m } = rig();
    // shots at 0, 3 and 6 s of a 10 s video; a cut 0.1 s from the end makes no shot of its own
    act(() => m().everyScene.mutate({ cuts: [3000, 6000, 9900], crf: 10 }));
    await waitFor(() => expect(useBanners.getState().items.map((b) => b.title)).toContain("Copying 3 shots to your library"));
    fakeApi.on("POST /assets/:id/range", () => jsonAnswer({ error: "zz-test: the queue refused it" }, 409));
    act(() => m().everyScene.mutate({ cuts: [3000], crf: 10 }));
    await waitFor(() => expect(m().everyScene.error?.message).toBe("zz-test: the queue refused it"));
  });
});
