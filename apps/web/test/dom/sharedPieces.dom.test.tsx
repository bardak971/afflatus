import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ConfirmHost } from "../../src/Confirm";
import { useFolders, useProjects } from "../../src/data";
import { DropTrayBody } from "../../src/DropTrayBody";
import { useItemMutations } from "../../src/itemMutations";
import { useTreeActions } from "../../src/projects/useTreeActions";
import type { Entity } from "../../src/api";
import { People } from "../../src/screens/People";
import { ComfyLog } from "../../src/screens/queue/Log";
import { useBanners } from "../../src/store";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

/**
 * The places that went their own way where the app has one shared piece (card #260): they now behave as the piece does.
 */

const project = { id: "zz-p", name: "zz-test project", folderId: "zz-root", archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", drafts: 0, timelines: 0, assets: 1 };
const folder = (id: string, parentId: string | null, name: string) => ({ id, parentId, name, count: 1, projectId: "zz-p", path: null, root: false });

/** The server's folders: a new one answered as made, under the parent asked for. */
function folders() {
  fakeApi.on("GET /projects", { items: [project], inbox: { drafts: 0, timelines: 0, assets: 0 } });
  fakeApi.on("GET /folders", { items: [folder("zz-root", null, "zz-test project"), folder("zz-sub", "zz-root", "zz-test sub")] });
  fakeApi.on("POST /folders", ({ body }) => {
    const b = body as { name: string; parentId: string | null };
    return { ...folder("zz-new", b.parentId, b.name), count: 0 };
  });
  fakeApi.on("POST /assets/move", { moved: 1 });
}

describe("a new folder from an item's menu", () => {
  it("is made as the Projects panel makes one, in the item's project under its root, and the item moves into it", async () => {
    folders();
    let m!: ReturnType<typeof useItemMutations>;
    function Probe() {
      m = useItemMutations();
      const projects = useProjects().data;
      const folders = useFolders().data;
      return projects && folders ? <span>read</span> : null;
    }
    const { user } = draw(<><Probe /><ConfirmHost /></>);
    await screen.findByText("read");
    act(() => void m.newFolderFor({ id: "zz-item", folderId: "zz-sub" }));
    // the tree's own question (useTreeActions newFolder), with the menu's word for what follows
    const dialog = await screen.findByRole("dialog", { name: "New folder in zz-test project" });
    await user.type(within(dialog).getByRole("textbox"), "zz-test shoots");
    await user.click(within(dialog).getByRole("button", { name: /Create and move/ }));
    await waitFor(() => expect(fakeApi.calls("POST", "/assets/move")).toHaveLength(1));
    expect(fakeApi.calls("POST", "/folders").map((c) => c.body)).toEqual([{ name: "zz-test shoots", parentId: "zz-root" }]);
    expect(fakeApi.calls("POST", "/assets/move")[0]!.body).toEqual({ ids: ["zz-item"], folderId: "zz-new" });
  });

  it("is named without the spaces around a typed name, and answered with the folder made", async () => {
    folders();
    let tree!: ReturnType<typeof useTreeActions>;
    function Probe() {
      tree = useTreeActions();
      return null;
    }
    draw(<Probe />);
    let made: Awaited<ReturnType<typeof tree.newFolder>> = null;
    await act(async () => { made = await tree.newFolder({ name: "zz-test project", parent: "zz-root", project: "zz-p", typed: "  zz-test typed  " }); });
    expect(fakeApi.calls("POST", "/folders").map((c) => c.body)).toEqual([{ name: "zz-test typed", parentId: "zz-root" }]);
    expect(made).toMatchObject({ id: "zz-new", name: "zz-test typed" });
  });
});

describe("files dropped on the tray's Add to this timeline", () => {
  /** Each file uploaded answered as the item it becomes, its kind from its type; the clips and the music taken, but `refuse`. */
  function server(refuse?: string) {
    let n = 0;
    fakeApi.on("POST /assets", ({ body }) => {
      const f = body as File;
      return { id: `zz-${f.type.split("/")[0]}-${++n}`, name: f.name, kind: f.type.split("/")[0] };
    });
    fakeApi.on("POST /timelines/:id/clips", ({ body }) => ((body as { asset: string }).asset === refuse ? jsonAnswer({ error: "zz-test refused" }, 400) : { clip: "zz-clip", timeline: {} }));
    fakeApi.on("PATCH /timelines/:id", {});
    fakeApi.on("GET /timelines", { items: [{ id: "zz-t", name: "zz-test timeline", clips: 0, updatedAt: "2026-11-01T00:00:00Z" }] });
  }
  const files = () => [
    new File(["p"], "zz-test.png", { type: "image/png" }),
    new File(["v"], "zz-test.mp4", { type: "video/mp4" }),
    new File(["s"], "zz-test.mp3", { type: "audio/mpeg" }),
  ];
  /** The drop, and the drag over as it is once dropped (the tray gone, what happened said). */
  function drop(r: ReturnType<typeof draw>) {
    const zone = screen.getByText("Add to this timeline").parentElement!;
    fireEvent.drop(zone, { dataTransfer: { files: files(), types: ["Files"] } });
    r.rerender(<DropTrayBody kind={null} />);
  }

  it("puts them on it the one way: a picture as a still, a video as a clip, a sound as its music; the timeline remembered as the last one", async () => {
    server();
    const r = draw(<DropTrayBody kind="image" />, { at: "/timelines/zz-t" });
    drop(r);
    expect(await screen.findByText("Added to the timeline.")).toBeTruthy();
    expect(fakeApi.calls("POST", "/timelines/zz-t/clips").map((c) => c.body)).toEqual([{ asset: "zz-image-1" }, { asset: "zz-video-2" }]);
    expect(fakeApi.calls("PATCH", "/timelines/zz-t").map((c) => c.body)).toEqual([{ music: { asset: "zz-audio-3" } }]);
    // "Add to <it>" with one key (A) goes there next (actions.ts useLast)
    expect(localStorage.getItem("afflatus.last-timeline")).toContain("zz-t");
  });

  it("goes on past one the server refuses, and says how many went", async () => {
    server("zz-image-1");
    const r = draw(<DropTrayBody kind="image" />, { at: "/timelines/zz-t" });
    drop(r);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("2 of 3 added, 1 failed · zz-test.png: zz-test refused"));
    expect(fakeApi.calls("PATCH", "/timelines/zz-t")).toHaveLength(1);
  });
});

describe("a copy the browser refuses", () => {
  afterEach(() => {
    Reflect.deleteProperty(document, "execCommand");
  });
  /** The clipboard of a page that may not write to it, and the old way refused too. */
  function refusing() {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("zz-test no focus")) } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
  }

  it("is said in a banner from the log's Copy, not swallowed", async () => {
    const { user } = draw(<ComfyLog online={false} />);
    refusing();
    await user.click(screen.getByRole("button", { name: /Copy/ }));
    await waitFor(() => expect(useBanners.getState().items.map((b) => b.title)).toContain("Could not copy the log"));
  });

  it("is said in a banner from the kit's Copy link, which its menu, closing, could not say", async () => {
    const person = { id: "zz-test-p1", kind: "person", name: "zz-test Ann", updatedAt: "", def: { pictures: [], voice: null, voicePart: null, tags: "", sentence: "a woman", models: {}, outfits: [] } } as unknown as Entity;
    fakeApi.on("GET /entities", { items: [person] });
    const { user } = draw(<People />, { at: "/kit" });
    const row = await screen.findByRole("button", { name: /zz-test Ann/ });
    refusing();
    fireEvent.contextMenu(row);
    await user.click(await screen.findByRole("menuitem", { name: /Copy link/ }));
    await waitFor(() => expect(useBanners.getState().items.map((b) => b.title)).toContain("Could not copy the link"));
  });

  it("lights the log's Copy when it went", async () => {
    const { user } = draw(<ComfyLog online={false} />);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.resolve() } });
    await user.click(screen.getByRole("button", { name: /Copy/ }));
    expect(await screen.findByRole("button", { name: /Copied/ })).toBeTruthy();
    expect(useBanners.getState().items).toHaveLength(0);
  });
});
