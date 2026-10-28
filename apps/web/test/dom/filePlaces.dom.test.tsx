import { beforeAll, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { FilePlaces, Job, MachineState } from "../../src/api";
import { ConfirmHost } from "../../src/Confirm";
import { ModelField } from "../../src/fields/FileSelect";
import { Loras } from "../../src/fields/Loras";
import { loadConfirmDialog } from "../../src/lazyParts";
import { WaitingList } from "../../src/screens/queue/WaitingList";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Where model files are across the machines, as the lists say it (card #139): a file only a pod lists says which pod and
 * is counted apart from the user's own; what a stopped pod's volume or its deploy's set holds is offered greyed; a render
 * waiting for that pod says so, with a Start that asks first (its rate) and is greyed at a spending cap.
 */

const own = { id: "m1", name: "", url: "http://127.0.0.1:8188", dir: "", takes: "all", packs: "ask", families: {} };
const pod = { ...own, id: "rp-1", name: "A40", url: "https://p1-8188.proxy.runpod.net", rented: { provider: "runpod", pod: "p1", idleMinutes: 10, idleDo: "stop", watchdogMinutes: 15 } };
const MINE = "zz-test-mine.safetensors";
const POD_ONLY = "zz-test-pod-only.safetensors";
const VOLUME = "zz-test-volume.safetensors";
const SET = "zz-test-set.safetensors";

function serve(places: FilePlaces) {
  fakeApi.on("GET /settings", { machines: [own, pod], hasRunpodKey: true });
  fakeApi.on("GET /setup", { comfy: { online: true }, recipes: [], lists: [], places });
  fakeApi.on("GET /official-sizes", { sizes: {}, asking: false });
  fakeApi.on("GET /models/:folder/info", { items: {}, pending: 0 });
  fakeApi.on("GET /models/updates", { items: [] });
  fakeApi.on("GET /model-words", { items: {} });
}

beforeAll(() => loadConfirmDialog());

describe("a model field across machines", () => {
  it("counts the user's own apart from a pod's, says which pod has a file, and offers a stopped pod's volume greyed", async () => {
    serve({
      on: { checkpoints: { [MINE]: ["m1"], [POD_ONLY]: ["rp-1"] } },
      offered: { checkpoints: [{ file: VOLUME, pod: "rp-1", via: "volume", bytes: 6 * 2 ** 30 }] },
      down: {},
    });
    const { user } = draw(<ModelField id="ckpt" spec={{ label: "Checkpoint", folder: "checkpoints" }} value={MINE} options={[MINE, POD_ONLY]} family={undefined} onChange={() => {}} />);
    expect(await screen.findByText("1 on your ComfyUI · 1 on pods only · 1 from pod volumes or sets")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Checkpoint:/ }));
    const list = await screen.findByRole("listbox", { name: "Checkpoint" });
    // the user's own first under their head, then the pod's under its own, then the pod's volume greyed
    expect(within(list).getByText("On your ComfyUI")).toBeTruthy();
    expect(within(list).getByText("On pod A40")).toBeTruthy();
    expect(within(list).getByText("On pod A40's volume")).toBeTruthy();
    const options = within(list).getAllByRole("option").map((o) => o.textContent);
    expect(options[0]).toContain("zz-test-mine");
    // under its pod's head, which says where it is: no note repeats it
    expect(options[1]).toBe("zz-test-pod-only");
    expect(options[2]).toMatch(/zz-test-volume.*6(\.0)? GB · not here/);
  });

  it("says a stopped pod's set file is fetched by it, and under the field that the job waits for that pod", async () => {
    serve({ on: { checkpoints: { [MINE]: ["m1"] } }, offered: { checkpoints: [{ file: SET, pod: "rp-1", via: "set", set: "Portraits" }] }, down: { "rp-1": "stopped" } });
    draw(<ModelField id="ckpt" spec={{ label: "Checkpoint", folder: "checkpoints" }} value={SET} options={[MINE]} family={undefined} onChange={() => {}} />);
    expect(await screen.findByText("In set Portraits · fetched by pod A40 · stopped · the job waits for that pod")).toBeTruthy();
  });

  it("says nothing of where a file is with the user's own machines alone", async () => {
    serve({ offered: {}, down: {} });
    draw(<ModelField id="ckpt" spec={{ label: "Checkpoint", folder: "checkpoints" }} value={MINE} options={[MINE, POD_ONLY]} family={undefined} onChange={() => {}} />);
    expect(await screen.findByText(/^2 on your ComfyUI$/)).toBeTruthy();
  });
});

describe("the LoRA picker across machines", () => {
  it("says which pod has a LoRA, and offers a stopped pod's set greyed", async () => {
    serve({ on: { loras: { [MINE]: ["m1", "rp-1"], [POD_ONLY]: ["rp-1"] } }, offered: { loras: [{ file: SET, pod: "rp-1", via: "set", set: "Portraits" }] }, down: { "rp-1": "stopped" } });
    const spec = { id: "loras", type: "loras", label: "LoRAs", max: 4 } as const;
    const { user } = draw(<Loras spec={spec} value={[]} options={[MINE, POD_ONLY]} family={undefined} model={undefined} onChange={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^LoRAs, add one/ }));
    const list = await screen.findByRole("listbox");
    const options = within(list).getAllByRole("option").map((o) => o.textContent);
    // on every machine: nothing said
    expect(options[0]).not.toMatch(/on /);
    expect(options[1]).toMatch(/on pod A40 \(stopped\)/);
    expect(within(list).getByText("In set Portraits · fetched by pod A40 · stopped")).toBeTruthy();
  });
});

describe("a render waiting for a stopped pod", () => {
  const rented = (over: Record<string, unknown> = {}) => ({ provider: "runpod", pod: "p1", status: "EXITED", rate: 0.69, gpu: "NVIDIA A40", capped: false, stopping: false, stoppedBy: "idle", files: [], packs: [], ...over }) as unknown as NonNullable<MachineState["rented"]>;
  const machines = (over: Record<string, unknown> = {}): MachineState[] => [
    { id: "m1", name: "", url: own.url, takes: "all", paused: false, online: true, locked: false, rented: null, model: null, pace: null, running: null } as unknown as MachineState,
    { id: "rp-1", name: "A40", url: pod.url, takes: "all", paused: false, online: false, locked: true, rented: rented(over), model: null, pace: null, running: null } as unknown as MachineState,
  ];
  const job = { id: "j1", recipe: "sdxl.text-to-picture", label: "zz-test picture", status: "queued", kind: "render", estimateMs: null, createdAt: new Date().toISOString(), machine: null, pinned: null, runsOn: [], startPod: "rp-1", lacks: { "rp-1": { off: false, files: [], sendable: false, why: "the pod is stopped" } } } as unknown as Job;

  it("says it waits for that pod, not that no machine can run it, and Start asks with its rate first", async () => {
    fakeApi.on("GET /settings", { machines: [own, pod] });
    fakeApi.on("POST /machines/:id/start", rented({ status: "RUNNING" }));
    const { user } = draw(<><WaitingList waiting={[job]} running={null} machines={machines()} onOrder={() => {}} onRemove={() => {}} /><ConfirmHost /></>);
    expect(await screen.findByText("waits for pod A40")).toBeTruthy();
    expect(screen.queryByText("no machine can run it")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Start" }));
    const question = await screen.findByRole("dialog");
    expect(within(question).getByText(/\$0\.69 \/ h/)).toBeTruthy();
    expect(fakeApi.calls("POST", "/machines/rp-1/start")).toHaveLength(0);
    await user.click(within(question).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/machines/rp-1/start")).toHaveLength(1));
  });

  it("greys Start at a spending cap", async () => {
    fakeApi.on("GET /settings", { machines: [own, pod] });
    draw(<WaitingList waiting={[job]} running={null} machines={machines({ capped: true })} onOrder={() => {}} onRemove={() => {}} />);
    const start = await screen.findByRole("button", { name: "Start" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(start.getAttribute("data-tip")).toMatch(/spending cap/);
  });
});
