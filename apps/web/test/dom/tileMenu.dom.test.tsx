import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { Asset } from "../../src/api";
import { loadTileMenuBody } from "../../src/lazyParts";
import { useTileMenu } from "../../src/TileMenu";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

const picture: Asset = {
  id: "zz-test-picture", kind: "image", origin: "upload", name: "zz-test picture", mime: "image/png", bytes: 1000, width: 64, height: 64,
  durationMs: null, fps: null, hasSound: false, kept: true, inBin: false, folderId: null, generationId: null, createdAt: "2026-10-11T00:00:00.000Z", path: null,
};

/** A library tile with its right-click menu, as the Studio's grid has it. */
function Tile({ asset, onOpen = () => {} }: { asset: Asset; onOpen?(a: Asset): void }) {
  const menu = useTileMenu({ onOpen });
  return (
    <>
      <button type="button" onContextMenu={(e) => menu.open(e, asset)}>{asset.name}</button>
      {menu.element}
    </>
  );
}

describe("a library tile's menu, drawn", () => {
  // the menu's body is a chunk the app fetches while it is idle: fetched before the test, as the app has it by then
  beforeAll(() => loadTileMenuBody());

  it("mirrors the item it was opened on, after the choice closed the menu (the request is not sent for an empty item)", async () => {
    fakeApi.on("GET /assets/:id", ({ params }) => ({ ...picture, id: params.id, generation: null }));
    fakeApi.on("POST /assets/:id/mirror", ({ params }) => ({ ...picture, id: `${params.id}-mirrored` }));
    const opened: Asset[] = [];
    const { user } = draw(<Tile asset={picture} onOpen={(a) => opened.push(a)} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: picture.name }), { button: 2, clientX: 20, clientY: 20 });
    await user.click(await screen.findByRole("menuitem", { name: "Passes" }));
    await user.click(screen.getByRole("menuitem", { name: /Mirror ↔/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(fakeApi.calls("POST", "/assets/")).toHaveLength(1));
    expect(fakeApi.calls("POST", "/assets/")[0]).toMatchObject({ path: `/assets/${picture.id}/mirror`, body: { axis: "horizontal" } });
    // the copy it made is shown, as the place opens an item
    await waitFor(() => expect(opened.map((a) => a.id)).toEqual([`${picture.id}-mirrored`]));
  });
});
