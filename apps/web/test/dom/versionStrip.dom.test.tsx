import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Asset, RecipeInfo } from "../../src/api";
import { useSendJob } from "../../src/queueVariation";
import { Viewer } from "../../src/Viewer";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** A picture and the two versions made of it in place, oldest first, as GET /assets/:id/versions answers. */
const picture = (id: string, at: string) => ({ id, name: `zz-test ${id}`, kind: "image", mime: "image/png", width: 64, height: 48, createdAt: at, kept: false, inBin: false, generationId: null }) as unknown as Asset;
const head = picture("zz-test-head", "2026-11-04T10:00:00Z");
const v1 = { ...picture("zz-test-v1", "2026-11-04T10:01:00Z"), versionOf: head.id };
const v2 = { ...picture("zz-test-v2", "2026-11-04T10:02:00Z"), versionOf: head.id };
const next = picture("zz-test-next", "2026-11-04T09:00:00Z");
const stack = { head, versions: [v1, v2] };

/** The viewer in place on the picture, the stack answered for every id of it. */
async function drawn() {
  fakeApi.on("GET /assets/:id/versions", stack);
  fakeApi.on("POST /assets/:id/versions/keep", ({ body }) => ({ head: [head, v1, v2].find((a) => a.id === (body as { version: string }).version), versions: [] }));
  fakeApi.on("POST /assets/:id/versions/keep-all", { head, versions: [] });
  const onOpen = vi.fn();
  const drawnViewer = draw(<Viewer inline asset={head} items={[head, next]} onOpen={onOpen} onClose={() => {}} />);
  await screen.findByRole("group", { name: "Versions" });
  return { onOpen, ...drawnViewer };
}
const pressed = () => screen.getAllByRole("button", { pressed: true }).find((b) => b.closest("[role=group]"))?.getAttribute("aria-label");
const key = (k: string, more: object = {}) => fireEvent.keyDown(window, { key: k, ...more });

describe("the versions strip under a picture", () => {
  it("shows the original as 0 and each version, ← → stepping through them before going on to the next item", async () => {
    const { onOpen } = await drawn();
    expect(screen.getByRole("button", { name: "The original" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Version 2" })).toBeTruthy();
    expect(pressed()).toBe("The original");
    key("ArrowRight");
    expect(pressed()).toBe("Version 1");
    key("ArrowRight");
    expect(pressed()).toBe("Version 2");
    expect(onOpen).not.toHaveBeenCalled();
    // past the last version: the next item of the list
    key("ArrowRight");
    expect(onOpen).toHaveBeenCalledWith(next);
    key("ArrowLeft");
    expect(pressed()).toBe("Version 1");
  });

  it("keeps the version shown on K, and every one on Keep all as pictures", async () => {
    await drawn();
    key("ArrowRight");
    key("ArrowRight");
    expect(screen.getByRole("button", { name: /Keep 2/ })).toBeTruthy();
    key("k");
    await waitFor(() => expect(fakeApi.calls("POST", "/assets/zz-test-head/versions/keep")).toHaveLength(1));
    expect(fakeApi.calls("POST", "/assets/zz-test-head/versions/keep")[0]!.body).toEqual({ version: "zz-test-v2" });
    fireEvent.click(screen.getByRole("button", { name: "Keep all as pictures" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/assets/zz-test-head/versions/keep-all")).toHaveLength(1));
  });

  it("reads its stack again after S or Del on a version, which leaves it: K finds no stale version (#325)", async () => {
    for (const [press, route] of [["s", "POST /assets/:id/keep"], ["Delete", "DELETE /assets/:id"]] as const) {
      fakeApi.reset();
      let left = false;
      await drawn();
      // the stack as the server says it once the version left it (a picture of its own, or in the bin)
      fakeApi.on("GET /assets/:id/versions", () => (left ? { head, versions: [v1] } : stack));
      fakeApi.on(route, () => {
        left = true;
        return route.startsWith("POST") ? { ...v2, kept: true } : { ok: true };
      });
      fakeApi.on("POST /drafts/using", { drafts: [] });
      key("ArrowRight");
      key("ArrowRight");
      expect(pressed()).toBe("Version 2");
      const reads = fakeApi.calls("GET", "/assets/").filter((c) => c.path.endsWith("/versions")).length;
      key(press);
      await waitFor(() => expect(fakeApi.calls("GET", "/assets/").filter((c) => c.path.endsWith("/versions")).length).toBeGreaterThan(reads));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Version 2" })).toBeNull());
      expect(screen.getByRole("button", { name: "Version 1" })).toBeTruthy();
      cleanup();
    }
  });

  it("puts two of them side by side in Compare on a Ctrl+click", async () => {
    await drawn();
    fireEvent.click(screen.getByRole("button", { name: "Version 1" }), { ctrlKey: true });
    expect(await screen.findByRole("button", { name: /Swap/ })).toBeTruthy();
    // the one shown pinned, the version clicked beside it
    expect(pressed()).toBe("Version 1");
    key("Escape");
    await waitFor(() => expect(screen.queryByRole("button", { name: /Swap/ })).toBeNull());
  });

  it("is not drawn for a picture with no versions", async () => {
    fakeApi.on("GET /assets/:id/versions", { head: next, versions: [] });
    draw(<Viewer inline asset={next} items={[next]} onOpen={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(fakeApi.calls("GET", "/assets/zz-test-next/versions")).toHaveLength(1));
    expect(screen.queryByRole("group", { name: "Versions" })).toBeNull();
  });
});

describe("a job queued as a version", () => {
  it("sends versionOf with the job, and nothing of it otherwise", async () => {
    fakeApi.on("POST /jobs", { ids: ["zz-test-job"] });
    let send!: ReturnType<typeof useSendJob>;
    function Probe() {
      send = useSendJob({ draft: "zz-test-draft" });
      return null;
    }
    draw(<Probe />);
    const recipe = { id: "zz-test.face", inputs: [{ id: "image", type: "image" }] } as unknown as RecipeInfo;
    await send({ recipe, stored: { image: head.id }, label: "Face refine", versionOf: head.id });
    await send({ recipe, stored: { image: head.id }, label: "Upscale 2x" });
    const bodies = fakeApi.calls("POST", "/jobs").map((c) => c.body as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ recipe: "zz-test.face", draft: "zz-test-draft", versionOf: head.id });
    expect(bodies[1]).not.toHaveProperty("versionOf");
  });
});
