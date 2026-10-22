import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { ConfirmHost } from "../../src/Confirm";
import { useOfficialSizes } from "../../src/data";
import { FirstLaunch } from "../../src/screens/FirstLaunch";
import { NoMachine } from "../../src/screens/queue/NoMachine";
import { ComfyCard } from "../../src/screens/settings/ComfyCard";
import { NoComfyCard } from "../../src/screens/settings/NoComfyCard";
import { fakeApi, jsonAnswer, later } from "./fakeApi";
import { draw } from "./render";

const deploy = vi.hoisted(() => ({ opened: 0 }));
vi.mock("../../src/deploy", async (original) => ({ ...(await original<typeof import("../../src/deploy")>()), openDeploy: () => void deploy.opened++ }));

/**
 * Where you render (card #20) as the user meets it: the first launch (a ComfyUI found, none found, rented GPUs only), the
 * Queue's row when no machine can take work (the RunPod key and the caps asked right there: money), and Settings › ComfyUI
 * with pods only.
 */

const settings = (o: Record<string, unknown> = {}) => ({ machines: [], hasRunpodKey: false, rentCaps: { day: 5, month: 25 }, allFamilies: true, comfyUrl: "http://127.0.0.1:8188", comfyDir: "", firstLaunch: "pending", ...o });
const own = { id: "m1", name: "", url: "http://127.0.0.1:8188", dir: "", takes: "all", packs: "ask", families: {} };
const pod = { id: "rp-1", name: "A40", url: "https://zz-test-8188.proxy.runpod.net", dir: "", takes: "all", packs: "ask", families: {}, rented: { provider: "runpod", pod: "zz-test" } };
const found = (o: Record<string, unknown> = {}) => ({ url: "http://127.0.0.1:8188", online: true, version: "0.3.60", device: "cuda:0 NVIDIA GeForce RTX 4070 Ti : cudaMallocAsync", locked: false, error: null, dir: "C:/zz-test/ComfyUI", local: true, ...o });

function serveSettings(start: Record<string, unknown>) {
  let now = start;
  fakeApi.on("GET /settings", () => now);
  fakeApi.on("PUT /settings", ({ body }) => {
    const patch = body as Record<string, unknown>;
    now = { ...now, ...patch, ...("comfyUrl" in patch ? { machines: [{ ...own, url: patch.comfyUrl }] } : {}) };
    return now;
  });
}

describe("the first launch", () => {
  it("offers the ComfyUI it found, its GPU said as every screen says it, and adds it", async () => {
    serveSettings(settings());
    fakeApi.on("GET /setup/find", { found: found(), tried: ["http://127.0.0.1:8188", "http://127.0.0.1:8000"] });
    const { user } = draw(<FirstLaunch />);
    await screen.findByText("Found");
    // core's shortGpu: the vendor words and the allocator gone
    expect(screen.getByText("RTX 4070 Ti")).toBeTruthy();
    expect(screen.getByText(/puts its node pack in it by itself/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Render on it" }));
    await waitFor(() => expect(fakeApi.calls("PUT", "/settings").map((c) => c.body)).toContainEqual({ comfyUrl: "http://127.0.0.1:8188" }));
  });

  it("says a ComfyUI on this PC whose folder was not found is to have it set, not that it is on another computer", async () => {
    serveSettings(settings());
    fakeApi.on("GET /setup/find", { found: found({ dir: null, local: true }), tried: ["http://127.0.0.1:8188"] });
    draw(<FirstLaunch />);
    expect(await screen.findByText(/On this PC, but its folder was not found/)).toBeTruthy();
    expect(screen.queryByText(/On another computer/)).toBeNull();
  });

  it("says a ComfyUI added without Test is on this PC from what the server knows, not from this page's probe", async () => {
    serveSettings(settings({ machines: [{ ...own, local: true }] }));
    // off when the page opened: nothing found, no Test pressed
    fakeApi.on("GET /setup/find", { found: null, tried: ["http://127.0.0.1:8188"] });
    const { client, rerender } = draw(<></>);
    await client.prefetchQuery({ queryKey: ["settings"], queryFn: () => fetch("/api/settings").then((r) => r.json()) });
    rerender(<FirstLaunch />);
    expect(await screen.findByText(/On this PC, but its folder was not found/)).toBeTruthy();
    expect(screen.queryByText(/On another computer/)).toBeNull();
  });

  it("with nothing found, asks, and lists the official installs", async () => {
    serveSettings(settings());
    fakeApi.on("GET /setup/find", { found: null, tried: ["http://127.0.0.1:8188", "http://127.0.0.1:8000"] });
    const { user } = draw(<FirstLaunch />);
    await screen.findByText(/Do you have ComfyUI installed/);
    await user.click(screen.getByRole("button", { name: "Not yet: I want to render on this PC" }));
    for (const name of ["ComfyUI Desktop", "ComfyUI portable", "Manual install"]) expect(screen.getByText(name)).toBeTruthy();
  });

  it("rented GPUs only: asks for the RunPod key and the caps, and takes out no machine when there was none", async () => {
    serveSettings(settings());
    fakeApi.on("GET /setup/find", { found: null, tried: ["http://127.0.0.1:8188"] });
    const { user } = draw(<FirstLaunch />);
    await user.click(await screen.findByRole("button", { name: "No: rented GPUs only" }));
    expect(await screen.findByLabelText("RunPod API key")).toBeTruthy();
    expect(screen.getByLabelText("Cap a day")).toHaveProperty("value", "5");
    expect(screen.getByLabelText("Cap a month")).toHaveProperty("value", "25");
    expect(fakeApi.calls("PUT", "/settings")).toEqual([]);
  });

  it("rented GPUs only after Change: asks before taking out the user's ComfyUI, and keeps it when told no", async () => {
    serveSettings(settings({ machines: [own, pod] }));
    fakeApi.on("GET /setup/find", { found: null, tried: ["http://127.0.0.1:8188"] });
    const { user, client, rerender } = draw(<ConfirmHost />);
    // opened on a ComfyUI already added (Show it again): its settings read before the page draws
    await client.prefetchQuery({ queryKey: ["settings"], queryFn: () => fetch("/api/settings").then((r) => r.json()) });
    rerender(<><FirstLaunch /><ConfirmHost /></>);
    await user.click(await screen.findByRole("button", { name: "Change" }));
    await user.click(await screen.findByRole("button", { name: "No: rented GPUs only" }));
    await screen.findByText("Render on rented GPUs only?");
    await user.click(screen.getByRole("button", { name: /^Cancel/ }));
    expect(fakeApi.calls("PUT", "/settings")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "No: rented GPUs only" }));
    await user.click(await screen.findByRole("button", { name: "Take it out" }));
    // the pods kept, the user's own machine gone
    await waitFor(() => expect(fakeApi.calls("PUT", "/settings").map((c) => (c.body as { machines?: Array<{ id: string }> }).machines?.map((m) => m.id))).toContainEqual(["rp-1"]));
  });
});

describe("the Queue with no machine", () => {
  it("asks for the RunPod key and the caps inline, saves a cap as typed, and opens Deploy once the key is saved", async () => {
    serveSettings(settings());
    const { user } = draw(<NoMachine waiting={2} />);
    expect(await screen.findByText("No machine yet")).toBeTruthy();
    const day = await screen.findByLabelText("Cap a day");
    await waitFor(() => expect(day).toHaveProperty("value", "5"));
    await user.clear(day);
    await user.type(day, "3{Enter}");
    await waitFor(() => expect(fakeApi.calls("PUT", "/settings").map((c) => c.body)).toContainEqual({ rentCaps: { day: 3, month: 25 } }));
    await user.type(screen.getByLabelText("RunPod API key"), "zz-test-runpod-key");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fakeApi.calls("PUT", "/settings").map((c) => c.body)).toContainEqual({ runpodKey: "zz-test-runpod-key" }));
    await waitFor(() => expect(deploy.opened).toBe(1));
  });

  it("with a key, offers Deploy and asks nothing", async () => {
    serveSettings(settings({ hasRunpodKey: true }));
    draw(<NoMachine waiting={0} />);
    expect(await screen.findByRole("button", { name: "Deploy a GPU…" })).toBeTruthy();
    expect(screen.queryByLabelText("RunPod API key")).toBeNull();
  });
});

describe("Settings › ComfyUI with no ComfyUI of the user's own", () => {
  it("does not offer a pod's address as the user's ComfyUI", async () => {
    // with pods only, the settings say the first pod's address
    serveSettings(settings({ machines: [pod], comfyUrl: pod.url }));
    const pending = later<Response>();
    fakeApi.on("GET /settings", () => pending.promise);
    const { user } = draw(<NoComfyCard />);
    const box = (await screen.findByLabelText("ComfyUI URL")) as HTMLInputElement;
    // The box starts empty, and an empty box is the answer, so an empty read proved nothing: a read before the settings'
    // effect has filled the box passed as well as a right one (review O-12). Typed into while the settings load, the box
    // is filled by that effect when they come, so its turning from what was typed is the settings drawn.
    await user.type(box, "zz-test typed");
    pending.answer(jsonAnswer(settings({ machines: [pod], comfyUrl: pod.url })));
    await waitFor(() => expect(box.value).not.toBe("zz-test typed"));
    expect(box.value).toBe("");
  });

  it("puts the user's own last address in the box once the settings arrive", async () => {
    // The other side of the case above: the settings are drawn into the box, so its staying empty there is the rule.
    serveSettings(settings({ machines: [pod], comfyUrl: "http://127.0.0.1:8000" }));
    draw(<NoComfyCard />);
    const box = await screen.findByLabelText("ComfyUI URL");
    await waitFor(() => expect((box as HTMLInputElement).value).toBe("http://127.0.0.1:8000"));
  });

  it("shows no 'no ComfyUI' card while the settings load, and says it when they fail", async () => {
    const pending = later<Response>();
    fakeApi.on("GET /settings", () => pending.promise);
    draw(<ComfyCard />);
    await waitFor(() => expect(fakeApi.calls("GET", "/settings").length).toBeGreaterThan(0));
    expect(screen.queryByText("Your ComfyUI")).toBeNull();
    pending.answer(jsonAnswer({ error: "zz-test the database is locked" }, 500));
    expect(await screen.findByText(/The settings could not be read/)).toBeTruthy();
    expect(screen.queryByText("Your ComfyUI")).toBeNull();
  });
});

describe("Settings › ComfyUI with the settings in hand", () => {
  it("keeps the card when the settings are read again and that read fails", async () => {
    serveSettings(settings({ machines: [own] }));
    const { client } = draw(<ComfyCard />);
    expect(await screen.findAllByLabelText("ComfyUI URL")).not.toEqual([]);
    // the server away for a moment (a restart): React Query keeps the settings it had
    fakeApi.on("GET /settings", () => jsonAnswer({ error: "zz-test the server is restarting" }, 500));
    await client.refetchQueries({ queryKey: ["settings"] });
    await waitFor(() => expect(client.getQueryState(["settings"])?.status).toBe("error"));
    expect(screen.queryByText(/The settings could not be read/)).toBeNull();
    expect(screen.getAllByLabelText("ComfyUI URL")).not.toEqual([]);
  });
});

describe("the official files' sizes", () => {
  function Sizes() {
    const sizes = useOfficialSizes();
    return <span>{sizes.data ? Object.keys(sizes.data).length : "none"} sizes</span>;
  }

  it("are read again once lookups are turned on, the server asking only with them on", async () => {
    serveSettings(settings({ civitaiLookups: false }));
    fakeApi.on("GET /official-sizes", { sizes: {}, asking: false });
    const { client } = draw(<Sizes />);
    await screen.findByText("0 sizes");
    await waitFor(() => expect(fakeApi.calls("GET", "/official-sizes").length).toBe(1));
    fakeApi.on("GET /official-sizes", { sizes: { "https://huggingface.co/zz-test/a.safetensors": 1024 }, asking: false });
    client.setQueryData(["settings"], { ...settings(), civitaiLookups: true });
    expect(await screen.findByText("1 sizes")).toBeTruthy();
    expect(fakeApi.calls("GET", "/official-sizes").length).toBe(2);
  });
});
