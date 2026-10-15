import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { MachineState, PodFile } from "../../src/api";
import { MachinesPill } from "../../src/MachinesPill";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** The status bar's machines pill while a rented pod gets the files its jobs wait for (the owner: "we need it"). */

const GB = 2 ** 30;
const file = (over: Partial<PodFile>): PodFile => ({ file: "a.safetensors", folder: "diffusion_models", state: "next", tier: "need", bytes: 0, total: GB, jobs: ["j"], ...over });
const local: Partial<MachineState> = { id: "m1", name: "", url: "http://127.0.0.1:8188", takes: "all", paused: true, online: true, locked: false, rented: null, model: null, pace: null, running: null };
const pod = (files: PodFile[]): Partial<MachineState> => ({
  ...local, id: "pod", name: "A40", url: "https://x-8188.proxy.runpod.net", paused: false,
  rented: { provider: "runpod", pod: "p1", status: "RUNNING", rate: 0.59, gpu: "A40", dataCenter: "CA-MTL-1", since: Date.now() - 60_000, spent: 0, diskPerDay: 0, volume: false, otherPorts: [], closedPorts: [], watchdog: "on", answers: true, idleAt: null, capped: false, stopping: false, stoppedBy: null, booting: false, error: null, files, packs: [] } as unknown as MachineState["rented"],
});

function serve(files: PodFile[]) {
  fakeApi.on("GET /queue", { online: true, paused: false, running: null, waiting: [], later: [], recent: [], machines: [local, pod(files)] });
  fakeApi.on("GET /settings", { hasRunpodKey: false });
}

describe("the machines pill, a pod getting files", () => {
  it("says which pod, how many files and how far, and its popover row says it is getting them, not idle", async () => {
    serve([file({ file: "gemma.safetensors", state: "fetching", bytes: 6 * GB, total: 14 * GB, via: "hf" }), file({ file: "ltx.safetensors", total: 6 * GB })]);
    const { user } = draw(<MachinesPill />);
    await waitFor(() => expect(screen.getByText(/A40 · 2 files ·/)).toBeTruthy());
    expect(screen.getByText("30 %")).toBeTruthy();
    await user.click(screen.getByRole("button", { expanded: false }));
    await waitFor(() => expect(screen.getByText(/getting 2 files for its jobs/)).toBeTruthy());
    expect(screen.getByText(/now: gemma\.safetensors · from Hugging Face/)).toBeTruthy();
  });

  it("says nothing of files once they are all there", async () => {
    serve([file({ state: "ready", bytes: GB })]);
    draw(<MachinesPill />);
    await waitFor(() => expect(screen.getByText(/ComfyUIs/)).toBeTruthy());
    expect(screen.queryByText(/files ·/)).toBeNull();
  });
});
