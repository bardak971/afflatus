import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { Opened } from "../../src/findModels/Opened";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The folder of a picked file (card #57): Find models offers the folders the server says (its ComfyUI's own beside the usual
 * ones), not a fixed list, and keeps the server's guess (RIFE in frame_interpolation) chosen.
 */

const repo = {
  site: "huggingface", id: "sisniha/frame_interpolation", name: "frame_interpolation", type: "", base: "", creator: "sisniha", downloads: 1, likes: 0, updatedAt: null, thumb: null, page: "",
  licence: { commercial: null, credit: false, derivatives: null }, fits: null, have: false, update: null, gated: false, versions: [], modelFiles: 2,
} as const;
const file = (name: string, folder: string | null) => ({ name, bytes: 1, note: "", sha256: null, folder, source: { kind: "url", url: `https://huggingface.co/x/resolve/main/${name}` }, have: [] });

describe("the folder of a picked file", () => {
  it("keeps RIFE in frame_interpolation, and offers a folder only ComfyUI knows for a file without one", async () => {
    fakeApi.on("GET /browse/huggingface/files", { files: [file("rife_v4.26.safetensors", "frame_interpolation"), file("zz-test.safetensors", null)] });
    fakeApi.on("GET /browse/folders", { folders: ["checkpoints", "frame_interpolation", "loras", "somepack_models"], comfy: true });
    const onPick = vi.fn();
    const { user } = draw(<Opened card={repo as never} picked={new Set()} onPick={onPick} onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: "Folder of rife_v4.26.safetensors: frame_interpolation" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Folder of zz-test.safetensors: Which folder?" }));
    const list = await screen.findByRole("listbox", { name: "Folder of zz-test.safetensors" });
    await waitFor(() => expect(within(list).getByRole("option", { name: "somepack_models" })).toBeTruthy());
    await user.click(within(list).getByRole("option", { name: "somepack_models" }));
    await user.click(screen.getByText("zz-test.safetensors"));
    await user.click(screen.getByRole("button", { name: "Pick it" }));
    expect(onPick).toHaveBeenCalledWith([expect.objectContaining({ file: "zz-test.safetensors", folder: "somepack_models" })]);
  });
});
