import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { FilePlaces, Job, Machine, MachineState, RecipeInfo, RecipeStatus } from "../../src/api";
import { GenerateOn, STOPPED_SAID } from "../../src/GenerateOn";
import { Form } from "../../src/RecipeForm";
import { useParts } from "../../src/recipeForm/Part";
import { WaitingList } from "../../src/screens/queue/WaitingList";
import { RentedRows } from "../../src/screens/settings/RentedRows";
import { useRentedOps } from "../../src/rentedOps";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * A stopped pod, as the pod re-check found it (card #149): a job pinned to it says it waits for that pod with Start, once;
 * Render on can pin to it; a file its set holds says under its field that the job waits for it, and nothing else; its
 * card shows an idle time not in the list as it is.
 */

const own = { id: "m1", name: "", url: "http://127.0.0.1:8188", dir: "", takes: "all", packs: "ask", families: {} };
const pod = { ...own, id: "rp-1", name: "RTX PRO 4000", url: "https://p1-8188.proxy.runpod.net", rented: { provider: "runpod", pod: "p1", idleMinutes: 3, idleDo: "stop", watchdogMinutes: 15, closedPorts: [], openPorts: false, makeRoom: false } };
const rented = (over: Record<string, unknown> = {}) => ({ provider: "runpod", pod: "p1", status: "EXITED", rate: 0.57, gpu: "NVIDIA RTX PRO 4000", capped: false, stopping: false, stoppedBy: "you", files: [], packs: [], otherPorts: [], ...over }) as unknown as NonNullable<MachineState["rented"]>;
const states = (): MachineState[] => [
  { id: "m1", name: "", url: own.url, takes: "all", paused: false, online: true, locked: false, rented: null, model: null, pace: null, running: null } as unknown as MachineState,
  { id: "rp-1", name: pod.name, url: pod.url, takes: "all", paused: false, online: false, locked: true, rented: rented(), model: null, pace: null, running: null } as unknown as MachineState,
  { id: "rp-2", name: "A40", url: "https://p2-8188.proxy.runpod.net", takes: "all", paused: false, online: true, locked: true, rented: rented({ pod: "p2", status: "RUNNING", gpu: "NVIDIA A40" }), model: null, pace: null, running: null } as unknown as MachineState,
];

describe("a job pinned to a stopped pod, in the Queue", () => {
  const job = {
    id: "j1", recipe: "sdxl.text-to-picture", label: "zz-test picture", status: "queued", kind: "render", estimateMs: null, createdAt: new Date().toISOString(),
    machine: null, pinned: "rp-1", runsOn: ["m1", "rp-2"], startPod: "rp-1", lacks: { "rp-1": { off: false, files: [], sendable: false, why: "the pod is stopped" } },
  } as unknown as Job;

  it("says it waits for that pod with Start, once, whatever else could run it", async () => {
    fakeApi.on("GET /settings", { machines: [own, pod] });
    draw(<WaitingList waiting={[job]} running={null} machines={states()} onOrder={() => {}} onRemove={() => {}} />);
    const said = await screen.findByText("waits for pod RTX PRO 4000");
    expect(said.getAttribute("data-tip")).toMatch(/^Pinned to RTX PRO 4000, which is stopped/);
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    // not a second line saying the pod is stopped, with no Start ("Run on another machine from its menu")
    expect(screen.queryByText(/the pod is stopped/)).toBeNull();
    expect(screen.queryByText(/Run on another machine/)).toBeNull();
  });
});

describe("Render on, with a stopped pod", () => {
  it("can pick it, saying it is stopped and its jobs wait for it", async () => {
    fakeApi.on("GET /queue", { online: true, paused: false, running: null, waiting: [], later: [], recent: [], machines: states() });
    fakeApi.on("GET /setup", { recipes: [] });
    const recipe = { id: "zz-test.picture", inputs: [], output: "image" } as never;
    const { user } = draw(<GenerateOn recipe={recipe} pickKey="zz-test-stopped" whole={{}} look={undefined as never} msOn={() => null} of="draft" />);
    await user.click(await screen.findByRole("button", { name: "Render on a machine of your choosing" }));
    const row = (await screen.findByText("RTX PRO 4000")).closest("button")!;
    expect(within(row).getByText(`· ${STOPPED_SAID}`)).toBeTruthy();
    expect((row as HTMLButtonElement).disabled).toBe(false);
    await user.click(row);
    expect(screen.getByRole("button", { name: "Render on a machine of your choosing" }).getAttribute("data-tip")).toMatch(/^Renders on RTX PRO 4000/);
  });
});

describe("a stopped pod's set file picked in a form", () => {
  beforeEach(() => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
    useParts.setState({ open: { model: true, sampling: true } });
  });
  afterEach(() => vi.restoreAllMocks());

  const SET = "zz-test-set.safetensors";
  const recipe = { id: "zz-test.sdxl", family: "sdxl", title: "txt2img", output: "image", inputs: [{ id: "prompt", type: "prompt", label: "Prompt" }, { id: "checkpoint", type: "model", label: "Checkpoint", folder: "checkpoints" }] } as unknown as RecipeInfo;
  const status = { id: recipe.id, ready: true, missingNodes: [], missingSlots: [], emptyInputs: [], missingFiles: [], options: { checkpoint: ["zz-test-mine.safetensors"] } } as unknown as RecipeStatus;
  const serve = (places: FilePlaces) => {
    fakeApi.on("GET /settings", { machines: [own, pod] });
    fakeApi.on("GET /setup", { comfy: { online: true }, recipes: [status], lists: [], places });
    fakeApi.on("GET /official-sizes", { sizes: {}, asking: false });
    fakeApi.on("GET /presets/files", { online: true, items: [] });
  };

  it("says one line, that the job waits for that pod: not that ComfyUI does not have it", async () => {
    serve({ on: { checkpoints: { "zz-test-mine.safetensors": ["m1"] } }, offered: { checkpoints: [{ file: SET, pod: "rp-1", via: "set", set: "Portraits" }] }, down: { "rp-1": "stopped" } });
    draw(<Form recipe={recipe} status={status} stored={{ checkpoint: SET }} onChange={() => {}} onClear={() => {}} />);
    expect(await screen.findByText(/the job waits for that pod$/)).toBeTruthy();
    // what is said under a missing model is loaded apart (lazy): given its time to come
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByText(/ComfyUI does not have/)).toBeNull();
  });

  it("still says ComfyUI does not have a file no pod holds", async () => {
    serve({ on: { checkpoints: { "zz-test-mine.safetensors": ["m1"] } }, offered: {}, down: { "rp-1": "stopped" } });
    draw(<Form recipe={recipe} status={status} stored={{ checkpoint: "zz-test-gone.safetensors" }} onChange={() => {}} onClear={() => {}} />);
    expect(await screen.findByText(/ComfyUI does not have/)).toBeTruthy();
  });
});

describe("the pod's card", () => {
  function Card({ machine, state }: { machine: Machine; state: MachineState }) {
    const ops = useRentedOps();
    return <RentedRows machine={machine} state={state} put={() => {}} ops={ops} remove={() => {}} />;
  }

  it("shows an idle time set outside its list (3 min at Deploy) as it is", async () => {
    fakeApi.on("GET /settings", { machines: [own, pod] });
    draw(<Card machine={pod as unknown as Machine} state={states()[1]!} />);
    const idle = await screen.findByRole("button", { name: /^Minutes idle before/ });
    expect(idle.textContent).toMatch(/3 min/);
    expect(idle.textContent).not.toMatch(/Choose/);
  });

  it("says a volume's disk at its own size", async () => {
    fakeApi.on("GET /settings", { machines: [own, pod] });
    const up = { ...states()[1]!, online: true, rented: rented({ status: "RUNNING", volume: true, disk: { free: 9 * 2 ** 30, total: 15 * 2 ** 30, at: Date.now() } }) } as MachineState;
    draw(<Card machine={pod as unknown as Machine} state={up} />);
    await waitFor(() => expect(screen.getByText(/in use$/).textContent).toMatch(/^6(\.0)?\/15(\.0)? GB in use$/));
  });
});
