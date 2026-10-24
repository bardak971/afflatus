import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";
import { Tray } from "../../src/findModels/Tray";
import { pickedOf, thisPcTarget } from "../../src/findModels/store";
import { useBanners } from "../../src/store";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

/**
 * Find models opened to download onto this PC (Settings › Models, the command bar), card #80: a Civitai file is asked for
 * by its hash and Civitai's id beside its name (Civitai's version page may call it otherwise), and a download the server
 * refuses is said in a banner (it was said nowhere).
 */

const SHA = "B".repeat(64);
const card = {
  site: "civitai", id: "2877206", name: "DaSiWa MiniMax H3", type: "Checkpoint", base: "MiniMax H3", creator: "", downloads: 1, likes: 0, updatedAt: null, thumb: null,
  page: "https://civitai.com/models/2877206", licence: { commercial: null, credit: false, derivatives: null }, fits: null, have: false, update: null, gated: false, versions: [],
} as const;
const int8 = {
  name: "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors", bytes: 1, note: "int8", sha256: SHA, folder: "diffusion_models", have: [],
  source: { kind: "civitai", version: 3374439, pick: "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors", fileId: 3263048, sha256: SHA },
} as const;

function OnThisPc() {
  const target = thisPcTarget(useQueryClient());
  const files = [pickedOf(int8 as never, card as never, "DaSiWa Hybrid Turbo v3")];
  return <Tray files={files} target={target} onRemove={() => {}} onClear={() => {}} onDone={() => {}} dropping={false} onOver={() => {}} onDrop={() => {}} />;
}

describe("Get on this PC from Find models", () => {
  it("asks for the file by its hash and id, and says a refused download in a banner", async () => {
    useBanners.setState({ items: [] });
    fakeApi.on("GET /downloads", { on: true, items: [] });
    const why = "Civitai no longer lists DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors for this version: open it again in Find models.";
    fakeApi.on("POST /downloads", () => jsonAnswer({ error: why }, 409));
    const { user } = draw(<OnThisPc />);
    await user.click(await screen.findByRole("button", { name: /Get on this PC/ }));
    await waitFor(() => expect(useBanners.getState().items.some((b) => b.tone === "bad")).toBe(true));
    expect(fakeApi.calls("POST", "/downloads")[0]!.body).toEqual({
      file: int8.name, folder: "diffusion_models", civitai: 3374439, pick: int8.name, sha256: SHA, fileId: 3263048,
    });
    expect(useBanners.getState().items.at(-1)).toMatchObject({ title: "Not downloaded", text: `${int8.name}: ${why}` });
  });
});
