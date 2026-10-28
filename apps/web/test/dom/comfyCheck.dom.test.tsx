import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FirstLaunch } from "../../src/screens/FirstLaunch";
import { ComfyCard } from "../../src/screens/settings/ComfyCard";
import { notReady } from "../../src/format";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The ComfyUI check (card #143) as a user on an old setup meets it: the first launch and Settings › ComfyUI say which
 * families that ComfyUI is too old for and the one thing to do, its PyTorch when its CUDA slows the int8 files, a form's
 * missing core nodes as an update of ComfyUI, and the node pack's row restarts ComfyUI through its Manager.
 */

const own = { id: "m1", name: "", url: "http://127.0.0.1:8188", dir: "C:/zz-test/ComfyUI", takes: "all", packs: "ask", families: {}, tokenEnd: "", local: true };
const settings = { machines: [own], hasRunpodKey: false, rentCaps: { day: 5, month: 25 }, allFamilies: true, comfyUrl: own.url, comfyDir: own.dir, firstLaunch: "done" };
const tooOld = { needs: "0.37.0", families: [{ id: "h3", name: "MiniMax H3", needs: "0.35.0", only: null, of: 4 }, { id: "ltx25", name: "LTX 2.5", needs: "0.32.0", only: null, of: 2 }, { id: "qwen21", name: "Qwen Image 2.1", needs: "0.37.0", only: null, of: 3 }] };
const update = "cd /d \"C:/zz-test/ComfyUI\"\ngit pull\npython -m pip install -r requirements.txt";
const old = { version: "0.3.10", pytorch: "2.4.0+cu121", tooOld, update };
const found = { url: own.url, online: true, ...old, device: "cuda:0 NVIDIA GeForce RTX 4070 Ti : cudaMallocAsync", locked: false, error: null, dir: own.dir, local: true };
const access = { state: "open", canLock: true, local: true };
const probe = (o: Record<string, unknown> = {}) => ({ id: "m1", online: true, error: null, ...old, device: found.device, vramTotal: 12 * 2 ** 30, vramFree: 8 * 2 ** 30, pack: null, access, tokenEnd: "", ...o });
const scan = { comfy: { online: true, url: own.url, version: "0.3.10", pytorch: "2.4.0+cu121", device: found.device, vramTotal: 12 * 2 ** 30, vramFree: 8 * 2 ** 30, nodes: 510 }, families: [], recipes: [], lists: {} };

function serve(o: { machines?: unknown[]; pack?: Record<string, unknown> } = {}) {
  fakeApi.on("GET /settings", settings);
  fakeApi.on("GET /machines", o.machines ?? [probe()]);
  fakeApi.on("GET /setup", scan);
  fakeApi.on("GET /queue", { running: [], waiting: [], machines: [], paused: false });
  fakeApi.on("GET /comfy/node-pack", { pack: "afflatus-nodes", path: "", written: false, loaded: true, canWrite: true, manager: null, ...o.pack });
}

describe("an old ComfyUI, as the first launch finds it", () => {
  it("says what it is too old for and the one thing to do, with what to run copied, and its PyTorch's CUDA", async () => {
    fakeApi.on("GET /settings", { ...settings, machines: [], firstLaunch: "pending" });
    fakeApi.on("GET /setup/find", { found, tried: [own.url] });
    const { user } = draw(<FirstLaunch />);
    await screen.findByText("Found");
    expect(screen.getByText("too old for 3 families")).toBeTruthy();
    expect(screen.getByText("PyTorch 2.4.0 · CUDA 12.1")).toBeTruthy();
    expect(screen.getByText(/ComfyUI v0\.3\.10 is too old for/).textContent).toMatch(/MiniMax H3, LTX 2\.5, Qwen Image 2\.1: they need v0\.37\.0 or newer/);
    expect(screen.getByText(/PyTorch built for CUDA 12\.1: ComfyUI runs the int8 \(convrot\) and NVFP4 files without its CUDA kernels/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy what to run" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
  });

  it("says nothing more of one that runs everything", async () => {
    fakeApi.on("GET /settings", { ...settings, machines: [], firstLaunch: "pending" });
    fakeApi.on("GET /setup/find", { found: { ...found, version: "0.42.5", pytorch: "2.10.0+cu130", tooOld: null, update: null }, tried: [own.url] });
    draw(<FirstLaunch />);
    await screen.findByText("Found");
    expect(screen.getByText("PyTorch 2.10.0 · CUDA 13.0")).toBeTruthy();
    expect(screen.queryByText(/too old/)).toBeNull();
    expect(screen.queryByText(/without its CUDA kernels/)).toBeNull();
  });
});

describe("Settings › ComfyUI on an old ComfyUI", () => {
  it("shows the version and PyTorch as chips, a row with the families it cannot run and what to run, and a PyTorch row", async () => {
    serve();
    draw(<ComfyCard />);
    expect(await screen.findByText("v0.3.10")).toBeTruthy();
    expect(screen.getByText("PyTorch 2.4.0 · CUDA 12.1")).toBeTruthy();
    // the row's name is drawn in two pieces (its "?" held to the last word): what it says is read
    expect((await screen.findByText("MiniMax H3, LTX 2.5, Qwen Image 2.1")).parentElement!.textContent).toMatch(/need ComfyUI v0\.37\.0 or newer: their nodes are ComfyUI's own\. The other families run as they are\. Update ComfyUI, then Test again\./);
    expect(screen.getByRole("button", { name: "Copy what to run" })).toBeTruthy();
    expect(screen.getByText(/Built for CUDA 12\.1: ComfyUI runs the int8 \(convrot\) and NVFP4 files/)).toBeTruthy();
  });

  it("says the update's ways in words when Afflatus does not know how this ComfyUI was installed", async () => {
    serve({ machines: [probe({ update: null, pytorch: "2.10.0+cu130" })] });
    draw(<ComfyCard />);
    expect(await screen.findByText("MiniMax H3, LTX 2.5, Qwen Image 2.1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy what to run" })).toBeNull();
    expect(screen.getByText(/Update ComfyUI \(git pull in its folder, then pip install -r requirements\.txt; on the portable, update\\update_comfyui\.bat/)).toBeTruthy();
    expect(screen.queryByText(/Built for CUDA/)).toBeNull();
  });
});

describe("the node pack written, ComfyUI not restarted", () => {
  it("restarts ComfyUI through its Manager, then says the pack loaded", async () => {
    serve({ machines: [probe({ tooOld: null, update: null, version: "0.42.5", pytorch: "2.10.0+cu130" })], pack: { written: true, loaded: false, manager: true } });
    fakeApi.on("POST /comfy/restart", () => {
      fakeApi.on("GET /comfy/node-pack", { pack: "afflatus-nodes", path: "", written: true, loaded: true, canWrite: true, manager: null });
      return { ok: true };
    });
    const { user } = draw(<ComfyCard />);
    await user.click(await screen.findByRole("button", { name: "Restart ComfyUI" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/comfy/restart")).toHaveLength(1));
    expect(await screen.findByText("Loaded", {}, { timeout: 5000 })).toBeTruthy();
  });

  it("says to restart it by hand where no ComfyUI-Manager can, with no button", async () => {
    serve({ machines: [probe({ tooOld: null, update: null })], pack: { written: true, loaded: false, manager: false } });
    draw(<ComfyCard />);
    expect(await screen.findByText(/no ComfyUI-Manager to restart it from here, restart ComfyUI the way you started it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart ComfyUI" })).toBeNull();
  });
});

describe("a form whose nodes ComfyUI lacks", () => {
  const status = (missingNodes: string[]) => ({ id: "h3.video", ready: false, missingNodes, missingSlots: [], emptyInputs: [], missingFiles: [], missing: [], problems: [], limitedBy: [], options: {} });

  it("says ComfyUI's own nodes as an update of ComfyUI, and a pack's as the pack to install", () => {
    const core = notReady(status(["MiniMaxH3SigmaShift", "MiniMaxH3ImageToVideo", "VAEDecodeAudio"]), true)!;
    expect(core).toMatch(/^ComfyUI lacks its own nodes MiniMaxH3SigmaShift, MiniMaxH3ImageToVideo, VAEDecodeAudio, which came with ComfyUI v0\.30\.0: update ComfyUI/);
    expect(core).not.toMatch(/Install Missing Custom Nodes/);
    expect(notReady(status(["VedaSparseAttention"]), true)).toMatch(/^ComfyUI needs the node pack veda-sparse-attention: in ComfyUI-Manager/);
  });
});
