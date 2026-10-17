import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { Job, MachineLack, MachineState, PodFile, QueueStatus, RunningJob } from "../../src/api";
import { MachineLanes } from "../../src/screens/queue/MachineLanes";
import { WaitingList } from "../../src/screens/queue/WaitingList";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The Queue's machines and waiting list as the owner picked them (2026-10-17, mock "Queue view", fixed rows): every machine
 * one row that never opens, its files said once there, a waiting job pinned to it only saying it waits for them. Before,
 * each waiting job listed the same files with their downloads and NEXT was drawn over the history.
 */

const GB = 2 ** 30;
const file = (over: Partial<PodFile>): PodFile => ({ file: "a.safetensors", folder: "vae", state: "next", tier: "need", bytes: 0, total: GB, jobs: ["j1", "j2"], ...over });
const local = (over: Partial<MachineState> = {}): MachineState => ({ id: "m1", name: "Studio PC", url: "http://127.0.0.1:8188", takes: "all", paused: false, online: true, locked: false, rented: null, model: null, pace: null, running: null, ...over }) as MachineState;
const pod = (files: PodFile[]): MachineState => local({
  id: "pod", name: "RTX 4090", url: "https://x-8188.proxy.runpod.net",
  rented: { provider: "runpod", pod: "p1", status: "RUNNING", rate: 0.69, gpu: "RTX 4090", dataCenter: "EU-RO-1", since: Date.now() - 60_000, spent: 0, diskPerDay: 0, volume: false, otherPorts: [], closedPorts: [], watchdog: "on", answers: true, idleAt: null, capped: false, stopping: false, stoppedBy: null, booting: false, error: null, files, packs: [], disk: null } as unknown as MachineState["rented"],
});
const run = (over: Partial<RunningJob> = {}): RunningJob => ({ id: "r1", recipe: "sdxl.text-to-picture", label: "zz-test picture", kind: "render", phase: "sampling", step: 9, steps: 28, progress: 0.3, eta: 30, previewSeq: 0, startedAt: new Date().toISOString(), ...over }) as RunningJob;
const lack = (files: string[]): MachineLack => ({ off: false, files: files.map((f) => ({ file: f, folder: "vae" })) });
const job = (id: string, pinned: string, lacks: MachineLack): Job => ({ id, recipe: "h3.video", label: `zz-test clip ${id}`, status: "queued", kind: "render", estimateMs: 480_000, createdAt: new Date().toISOString(), machine: pinned, pinned, lacks: { [pinned]: lacks } }) as unknown as Job;
const status = (machines: MachineState[]): QueueStatus => ({ online: true, paused: false, running: null, waiting: [], later: [], recent: [], machines, tool: null }) as unknown as QueueStatus;

function serve() {
  fakeApi.on("GET /settings", { hasRunpodKey: true, machines: [] });
}

describe("the Queue's machines, a row each", () => {
  it("says a pod's files there once, how many and how far, with Files › to the pod's card; nothing opens", async () => {
    serve();
    const files = [file({ file: "qwen3vl.safetensors", state: "fetching", bytes: 6 * GB, total: 12 * GB, via: "hf" }), file({ file: "video_vae.safetensors" }), file({ file: "audio_vae.safetensors" })];
    draw(<MachineLanes q={status([local({ running: run() }), pod(files)])} onStop={() => {}} onPin={() => {}} />);
    const row = within(await screen.findByRole("region", { name: "RTX 4090" }));
    expect(row.getByText("3 files for its jobs")).toBeTruthy();
    expect(row.getByText(/now: qwen3vl\.safetensors · from Hugging Face/)).toBeTruthy();
    expect(row.getByRole("link", { name: "Files ›" }).getAttribute("href")).toContain("/settings/rented");
    // the other files only in the tip, never as rows of their own
    expect(row.queryByText("video_vae.safetensors")).toBeNull();
    // no lane opens, and the meter tiles (and the Pace tile) are gone
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
    expect(screen.queryByText("Pace")).toBeNull();
  });

  it("gives a rendering machine its job, step, time left, GPU and VRAM, and a Stop", async () => {
    serve();
    let stopped = "";
    const { user } = draw(<MachineLanes q={status([local({ running: run() })])} onStop={(id) => (stopped = id)} onPin={() => {}} />);
    const row = within(await screen.findByRole("region", { name: "Studio PC" }));
    expect(row.getByText("zz-test picture")).toBeTruthy();
    expect(row.getByText("sampling 9/28 · 0:30 left")).toBeTruthy();
    await user.click(row.getByRole("button", { name: "Stop zz-test picture" }));
    expect(stopped).toBe("r1");
  });
});

describe("the waiting list, files said once", () => {
  it("has jobs pinned to a pod getting their files point at its row, without listing them", async () => {
    serve();
    const names = ["qwen3vl.safetensors", "video_vae.safetensors", "audio_vae.safetensors"];
    const machines = [local(), pod(names.map((f, i) => file({ file: f, state: i ? "next" : "fetching" })))];
    draw(<WaitingList waiting={[job("j1", "pod", lack(names)), job("j2", "pod", lack(names))]} running={null} machines={machines} onOrder={() => {}} onRemove={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "waits for 3 files on RTX 4090 ↑" })).toHaveLength(2));
    expect(screen.queryByText(/then runs there/)).toBeNull();
    expect(screen.queryByText("video_vae.safetensors")).toBeNull();
  });

  it("lists files no machine is getting under the first job only, the next one with the same files pointing at it", async () => {
    serve();
    const names = ["video_vae.safetensors", "audio_vae.safetensors"];
    draw(<WaitingList waiting={[job("j1", "m1", lack(names)), job("j2", "m1", lack(names))]} running={null} machines={[local(), local({ id: "m2", name: "Second GPU" })]} onOrder={() => {}} onRemove={() => {}} />);
    await waitFor(() => expect(screen.getByText(/then runs there/)).toBeTruthy());
    expect(screen.getAllByText("video_vae.safetensors")).toHaveLength(1);
    expect(screen.getByText("· waits for the same 2 files as 1")).toBeTruthy();
  });
});
