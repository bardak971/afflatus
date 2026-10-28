import { beforeAll, describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import type { Job, Machine, MachineState, RedeployOffer } from "../../src/api";
import { ConfirmHost } from "../../src/Confirm";
import { loadConfirmDialog } from "../../src/lazyParts";
import { useRentedOps } from "../../src/rentedOps";
import { WaitingList } from "../../src/screens/queue/WaitingList";
import { RentedRows } from "../../src/screens/settings/RentedRows";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

/**
 * What the 0.8.1 re-check found (card #150), in the page: a Start RunPod refuses for want of a GPU on the pod's host asks
 * whether to deploy a new pod on its volume (the GPU, the rate, how it ends) and deploys only on Deploy; a job pinned to a
 * pod that went says so; a pod's idle stop can be set under 5 min.
 */

const own = { id: "m1", name: "", url: "http://127.0.0.1:8188", dir: "", takes: "all", packs: "ask", families: {} };
const pod = { ...own, id: "rp-1", name: "RTX PRO 4000", url: "https://p1-8188.proxy.runpod.net", rented: { provider: "runpod", pod: "p1", idleMinutes: 3, idleDo: "stop", watchdogMinutes: 15, closedPorts: [], openPorts: false, makeRoom: false } };
const rented = { provider: "runpod", pod: "p1", status: "EXITED", rate: 0.57, gpu: "NVIDIA RTX PRO 4000", capped: false, stopping: false, stoppedBy: "you", files: [], packs: [], otherPorts: [] } as unknown as NonNullable<MachineState["rented"]>;
const states = (): MachineState[] => [
  { id: "m1", name: "", url: own.url, takes: "all", paused: false, online: true, locked: false, rented: null, model: null, pace: null, running: null } as unknown as MachineState,
  { id: "rp-1", name: pod.name, url: pod.url, takes: "all", paused: false, online: false, locked: true, rented, model: null, pace: null, running: null } as unknown as MachineState,
];
const waiting = (over: Partial<Job> = {}) => ({
  id: "j1", recipe: "sdxl.text-to-picture", label: "zz-test picture", status: "queued", kind: "render", estimateMs: null, createdAt: new Date().toISOString(),
  machine: null, pinned: "rp-1", runsOn: [], startPod: "rp-1", lacks: { "rp-1": { off: false, files: [], sendable: false, why: "the pod is stopped" } }, ...over,
}) as unknown as Job;
const offer = (over: Partial<RedeployOffer> = {}): RedeployOffer => ({
  name: "RTX PRO 4000", was: "RTX PRO 4000", gpu: { id: "NVIDIA RTX PRO 4000", name: "RTX PRO 4000", price: 0.56 }, same: true, sized: true, cloud: "SECURE", template: "afflatus", cuda: "13.0", cudaChanged: false,
  dataCenter: "EU-RO-1", volume: { id: "vol-1", name: "zz-test 0.8.1" }, refetch: null, disk: 40, rate: 0.5655, idleMinutes: 3, idleDo: "stop", watchdogMinutes: 15, ...over,
});

beforeAll(() => loadConfirmDialog());

/** The queue's row of a job waiting for the stopped pod, its Start pressed and confirmed; RunPod refusing it as on the re-check. */
async function startRefused(o: RedeployOffer, refusal: object = { error: "Start refused: its GPU was taken while it was stopped (no free GPU on its host). Deploy a new pod on its volume, or Start again later.", redeploy: true }) {
  fakeApi.on("GET /settings", { machines: [own, pod] });
  fakeApi.on("POST /machines/:id/start", () => jsonAnswer(refusal, 409));
  fakeApi.on("GET /machines/:id/redeploy", o);
  fakeApi.on("POST /machines/:id/redeploy", { id: "rp-new" });
  const drawn = draw(<><WaitingList waiting={[waiting()]} running={null} machines={states()} onOrder={() => {}} onRemove={() => {}} /><ConfirmHost /></>);
  await act(async () => drawn.user.click(await screen.findByRole("button", { name: "Start" })));
  // its confirm (the rate, its idle stop), then the confirm's own Start
  await screen.findByText("Start RTX PRO 4000?", undefined, { timeout: 3000 });
  await act(async () => drawn.user.click(screen.getAllByRole("button", { name: "Start" }).at(-1)!));
  return drawn;
}

describe("a Start RunPod refuses for want of a GPU on the pod's host", () => {
  it("asks to deploy a new pod on its volume, with its GPU, the rate and how it ends, and deploys on Deploy", async () => {
    const { user } = await startRefused(offer());
    expect(await screen.findByText("Deploy a new pod for RTX PRO 4000?", undefined, { timeout: 3000 })).toBeTruthy();
    const text = screen.getByText(/^RunPod has no GPU free on its host/).textContent!;
    expect(text).toMatch(/A new RTX PRO 4000, on its volume "zz-test 0\.8\.1" \(its models are there\), at \$0\.57\/h/);
    expect(text).toMatch(/until it is stopped \(after 3 min idle, or by you\)/);
    expect(text).toMatch(/The renders pinned to it go to the new pod; RTX PRO 4000 stays stopped\./);
    // nothing deployed before the user says so
    expect(fakeApi.calls("POST", "/machines/rp-1/redeploy")).toEqual([]);
    await act(async () => user.click(screen.getByRole("button", { name: "Deploy" })));
    await waitFor(() => expect(fakeApi.calls("POST", "/machines/rp-1/redeploy").map((c) => c.body)).toEqual([{ gpu: "NVIDIA RTX PRO 4000" }]));
  });

  it("says plainly when the GPU offered is another, and deploys nothing when not confirmed", async () => {
    const { user } = await startRefused(offer({ gpu: { id: "NVIDIA RTX A6000", name: "RTX A6000", price: 0.49 }, same: false }));
    await screen.findByText("Deploy a new pod for RTX PRO 4000?", undefined, { timeout: 3000 });
    expect(screen.getByText(/^RunPod has no GPU free on its host/).textContent).toMatch(/A new RTX A6000 \(no RTX PRO 4000 is free in EU-RO-1; this one has as much memory or more\)/);
    await act(async () => user.click(screen.getByRole("button", { name: /^Cancel/ })));
    await new Promise((r) => setTimeout(r, 100));
    expect(fakeApi.calls("POST", "/machines/rp-1/redeploy")).toEqual([]);
  });

  it("says that a pod with no network volume fetches its models again, and how much", async () => {
    await startRefused(offer({ volume: null, dataCenter: null, refetch: { files: 2, bytes: 7 * 2 ** 30 }, idleDo: "terminate" }));
    await screen.findByText("Deploy a new pod for RTX PRO 4000?", undefined, { timeout: 3000 });
    expect(screen.getByText(/^RunPod has no GPU free on its host/).textContent).toMatch(/with no network volume: its models are fetched again \(2 files, 7(\.0)? GB\)/);
  });

  it("offers nothing for another refusal (a spending cap)", async () => {
    await startRefused(offer(), { error: "A spending cap is reached: raise it in Settings › Rented GPUs to start it." });
    await waitFor(() => expect(fakeApi.calls("POST", "/machines/rp-1/start")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(fakeApi.calls("GET", "/machines/rp-1/redeploy")).toEqual([]);
    expect(screen.queryByText("Deploy a new pod for RTX PRO 4000?")).toBeNull();
  });
});

describe("a job pinned to a pod that went", () => {
  it("says its pod was terminated, with Deploy a GPU, not the pod's bare id, with one machine left too", async () => {
    fakeApi.on("GET /settings", { machines: [own] });
    // one machine left: the queue's single-machine layout hands the list no machines
    draw(<WaitingList waiting={[waiting({ pinned: "rp-gone", pinGone: true, startPod: null, lacks: null })]} running={null} machines={[]} onOrder={() => {}} onRemove={() => {}} />);
    const chip = await screen.findByText("its pod was terminated");
    expect(chip.closest("[data-tip]")?.getAttribute("data-tip")).toMatch(/runs nowhere else by itself/);
    expect(screen.getByRole("button", { name: "Deploy a GPU…" })).toBeTruthy();
    expect(screen.queryByText("rp-gone")).toBeNull();
  });
});

describe("a pod's idle stop", () => {
  function Card({ machine, state }: { machine: Machine; state: MachineState }) {
    const ops = useRentedOps();
    return <RentedRows machine={machine} state={state} put={() => {}} ops={ops} remove={() => {}} />;
  }

  it("can be set from 1 min, as a test pod uses 2–3", async () => {
    fakeApi.on("GET /settings", { machines: [own, pod] });
    const { user } = draw(<Card machine={pod as unknown as Machine} state={states()[1]!} />);
    await act(async () => user.click(await screen.findByRole("button", { name: /^Minutes idle before/ })));
    for (const n of [1, 2, 3, 4]) expect(screen.getByRole("option", { name: `${n} min` })).toBeTruthy();
  });
});
