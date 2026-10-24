import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Download, FolderPlaces } from "../../src/api";
import { DownloadsCard, DownloadsChip } from "../../src/DownloadsLine";
import { GetFile } from "../../src/GetFile";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The downloads manager (card #60, mock-downloads-queue.html) and where a download lands (card #59): a clicked file's own
 * state where its Download was, the place on disk and its menu, the status bar's chip and popover, the Downloads card.
 */

const GB = 2 ** 30;
const dl = (id: string, over: Partial<Download> = {}): Download => ({ id, file: `${id}.safetensors`, folder: "loras", title: id, bytes: 0, total: GB, status: "starting", via: "afflatus", ...over });
const loras: FolderPlaces = {
  goes: "models\\loras",
  places: [
    { path: "C:\\ComfyUI\\models\\loras", kind: "own", shown: "models\\loras", ok: true },
    { path: "D:\\sd.webui\\models\\Lora", kind: "other", shown: "D:\\sd.webui\\models\\Lora", ok: true },
  ],
};

function serve(items: Download[], places: Record<string, FolderPlaces> = { loras }) {
  fakeApi.on("GET /settings", { downloadModels: true, civitaiLookups: true, machines: [{ id: "m1", url: "http://127.0.0.1:8188", local: true }], downloadPlaces: {} });
  fakeApi.on("GET /recipes", { families: [], recipes: [] });
  fakeApi.on("GET /downloads", { on: true, items, manager: { found: false }, via: "afflatus" });
  fakeApi.on("GET /downloads/places", { machine: "m1", folders: places });
}

describe("a file's Download, once clicked", () => {
  it("says its place in the line where its Download was, never a second Download, and ✕ takes it out", async () => {
    serve([dl("a", { status: "downloading", turn: 1 }), dl("b", { status: "downloading", turn: 2 }), dl("rife", { waiting: "behind a and b", turn: 3 })]);
    fakeApi.on("DELETE /downloads/:id", { ok: true });
    const { user } = draw(<GetFile file="rife.safetensors" folder="loras" url="https://example.test/rife.safetensors" buttons />);
    expect(await screen.findByText("In line · 3rd")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel rife" }));
    await waitFor(() => expect(fakeApi.calls("DELETE", "/downloads/rife")).toHaveLength(1));
  });

  it("says how far it is while it comes, then the folder it landed in", async () => {
    serve([dl("seed", { status: "downloading", turn: 1, bytes: 0.38 * GB, rate: 0 })]);
    const { unmount } = draw(<GetFile file="seed.safetensors" folder="loras" url="https://example.test/seed.safetensors" buttons />);
    expect(await screen.findByText("Downloading 38 %")).toBeTruthy();
    unmount();
    // the time left in the shared words (leftWords), as every other "left" in the app
    fakeApi.reset();
    serve([dl("seed", { status: "downloading", turn: 1, bytes: 0.38 * GB, rate: (0.62 * GB) / 40 })]);
    const second = draw(<GetFile file="seed.safetensors" folder="loras" url="https://example.test/seed.safetensors" buttons />);
    expect(await screen.findByText("Downloading 38 % · 1 min")).toBeTruthy();
    second.unmount();
    fakeApi.reset();
    serve([dl("te", { status: "done", shown: "models\\text_encoders", at: Date.now() })]);
    draw(<GetFile file="te.safetensors" folder="loras" url="https://example.test/te.safetensors" buttons />);
    expect(await screen.findByText("Here · models\\text_encoders")).toBeTruthy();
  });

  it("says where it goes before it is clicked, and keeps the place chosen among those ComfyUI reads (card #59)", async () => {
    serve([]);
    fakeApi.on("PUT /downloads/places", { ok: true });
    const { user } = draw(<GetFile file="new.safetensors" folder="loras" url="https://example.test/new.safetensors" buttons />);
    await user.click(await screen.findByRole("button", { name: /→ models\\loras/ }));
    const menu = within(screen.getByRole("menu"));
    expect(menu.getByText("ComfyUI")).toBeTruthy();
    expect(menu.getByText("extra_model_paths.yaml")).toBeTruthy();
    await user.click(menu.getByText("D:\\sd.webui\\models\\Lora"));
    await waitFor(() => expect(fakeApi.calls("PUT", "/downloads/places")[0]?.body).toEqual({ folder: "loras", path: "D:\\sd.webui\\models\\Lora" }));
  });

  it("says where it goes, with no menu, when the way downloads go cannot be told a place (ComfyUI-Manager, an older node pack)", async () => {
    serve([], { loras: { ...loras, fixed: true, goes: "D:\\sd.webui\\models\\Lora" } });
    draw(<GetFile file="new.safetensors" folder="loras" url="https://example.test/new.safetensors" buttons />);
    expect(await screen.findByText("→ D:\\sd.webui\\models\\Lora")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /→/ })).toBeNull();
  });
});

describe("the downloads manager", () => {
  const line = [
    dl("big", { status: "downloading", turn: 1, bytes: 0.38 * GB, rate: 48 * 2 ** 20, shown: "models\\diffusion_models", folder: "diffusion_models" }),
    dl("lora", { status: "downloading", turn: 2, bytes: 0.3 * GB, total: 0.4 * GB, rate: 41 * 2 ** 20 }),
    dl("rife", { waiting: "behind big and lora", turn: 3, folder: "frame_interpolation" }),
    dl("qwen", { waiting: "behind big and lora", turn: 4 }),
    dl("seedvr", { waiting: "behind big and lora", turn: 5 }),
  ];

  it("says the line in the status bar, and opens it: under way, next in order, moved by a drag, all waiting cancelled", async () => {
    serve(line);
    fakeApi.on("POST /downloads/:id/move", { ok: true });
    fakeApi.on("POST /downloads/cancel-waiting", { cancelled: 3 });
    const { user } = draw(<DownloadsChip />);
    const chip = await screen.findByRole("button", { name: /2 ↓ · 3 waiting/ });
    await user.click(chip);
    const pop = within(screen.getByRole("dialog", { name: "Downloads" }));
    expect(pop.getByText("Downloads · on this PC")).toBeTruthy();
    expect(pop.getByText("Under way")).toBeTruthy();
    expect(pop.getByText(/into models\\diffusion_models/)).toBeTruthy();
    expect(pop.getByText("Next · drag to change the order")).toBeTruthy();
    // seedvr dragged over rife's lower half (a drawn page has no layout: every row is at 0): it comes after rife, before qwen
    const rows = (name: string) => document.querySelector(`[data-tip="${name}.safetensors"]`)!.closest("[draggable]")!;
    fireEvent.dragStart(rows("seedvr"), { dataTransfer: { effectAllowed: "", setData() {} } });
    fireEvent.dragOver(rows("rife"));
    fireEvent.drop(rows("rife"));
    await waitFor(() => expect(fakeApi.calls("POST", "/downloads/seedvr/move")[0]?.body).toEqual({ before: "qwen" }));
    await user.click(pop.getByRole("button", { name: "Remove all waiting" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/downloads/cancel-waiting")).toHaveLength(1));
  });

  it("is a card in Settings › Models with what was done today, where it landed, and what failed with Try again", async () => {
    serve([...line, dl("te", { status: "done", shown: "models\\text_encoders", at: Date.now() }), dl("ltx", { status: "error", error: "Hugging Face refused: gated", again: true, at: Date.now() })]);
    fakeApi.on("POST /downloads/:id/again", dl("ltx2"));
    fakeApi.on("POST /downloads/clear", { cleared: 2 });
    const { user } = draw(<DownloadsCard />);
    const card = within(await screen.findByRole("region", { name: "Downloads" }));
    expect(card.getByText("Done today")).toBeTruthy();
    expect(card.getByText(/Here · models\\text_encoders/)).toBeTruthy();
    expect(card.getByText(/Hugging Face refused: gated/)).toBeTruthy();
    await user.click(card.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/downloads/ltx/again")).toHaveLength(1));
    await user.click(card.getByRole("button", { name: "Clear done" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/downloads/clear")).toHaveLength(1));
  });

  it("is nothing while nothing comes, nothing was done today and no place was chosen", async () => {
    serve([]);
    draw(<><DownloadsChip /><DownloadsCard /></>);
    await waitFor(() => expect(fakeApi.calls("GET", "/downloads")).not.toHaveLength(0));
    expect(screen.queryByRole("region", { name: "Downloads" })).toBeNull();
    expect(screen.queryByRole("button", { name: /↓/ })).toBeNull();
  });
});
