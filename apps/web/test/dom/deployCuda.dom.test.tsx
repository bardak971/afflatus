import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { DeployHost, openDeploy, type DeployOpening } from "../../src/deploy";
import { fakeApi, later } from "./fakeApi";
import { draw } from "./render";

/**
 * The Deploy dialog's CUDA question (money): the GPU wanted has hosts free, none with CUDA 13. "Deploy on CUDA 12.8" says
 * its rate as every deploy button does, the foot does not call the GPU out of stock, and the 12.8 deploy and the hunt lock
 * each other out while one is under way (two pods could be made).
 */

const lastDeploy = { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", cuda: "13.0", volume: "", disk: 120, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15, set: "", files: [], leaveOut: [], accept: [], again: false, makeRoom: true };
// free on hosts with an older driver only
const a40 = { id: "NVIDIA A40", name: "A40", memory: 48, price: 0.4, availability: "HIGH", cuda13: false, dataCenters: [{ id: "EU-RO-1", availability: "HIGH" }] };

async function open(how: DeployOpening, keyed: boolean) {
  fakeApi.on("GET /settings", { hasRunpodKey: keyed, machines: [], lastDeploy });
  fakeApi.on("GET /runpod/gpus", { gpus: [a40] });
  fakeApi.on("GET /runpod/images", { afflatus: true, runpod: true });
  fakeApi.on("GET /runpod/volumes", { volumes: [] });
  fakeApi.on("POST /hunt/rank", { ranking: [], held: 2, overhead: null });
  const deployed = later<object>();
  const hunted = later<object>();
  fakeApi.on("POST /runpod/deploy", () => deployed.promise);
  fakeApi.on("POST /hunt", () => hunted.promise);
  const drawn = draw(<DeployHost />, { at: "/queue" });
  await drawn.client.prefetchQuery({ queryKey: ["settings"], queryFn: () => fetch("/api/settings").then((r) => r.json()) });
  act(() => openDeploy(how));
  const on128 = await screen.findByRole("button", { name: /^Deploy on CUDA 12\.8/ }, { timeout: 5000 });
  await waitFor(() => expect((on128 as HTMLButtonElement).disabled).toBe(false));
  return { ...drawn, on128: on128 as HTMLButtonElement, deployed, hunted };
}

describe("the Deploy dialog's CUDA 12.8 question", () => {
  it("says the 12.8 deploy's rate on its button, and the foot says the GPU is free on 12.8 only", async () => {
    const { on128 } = await open("deploy", false);
    // the GPU's $0.40 and its 120 GB disk, as the Deploy button says a rate
    expect(on128.textContent).toMatch(/^Deploy on CUDA 12\.8 · \$0\.\d\d\/h$/);
    expect(on128.getAttribute("data-tip")).toMatch(/GPU \$0\.40 \+ its 120 GB disk/);
    expect(screen.getByText(/A40 free on CUDA 12\.8 only/)).toBeTruthy();
    expect(screen.queryByText(/A40 not in stock/)).toBeNull();
  });

  it("locks the hunt while the 12.8 deploy is under way", async () => {
    const { user, on128 } = await open("hunt", true);
    const hunt = await screen.findByRole("button", { name: /^Hunt · up to/ });
    await waitFor(() => expect((hunt as HTMLButtonElement).disabled).toBe(false));
    await user.click(on128);
    await waitFor(() => expect(fakeApi.calls("POST", "/runpod/deploy")).toHaveLength(1));
    expect(fakeApi.calls("POST", "/runpod/deploy")[0]!.body).toMatchObject({ cuda: "12.8", cudaOnce: true });
    await waitFor(() => expect((hunt as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByRole("button", { name: "Deploying…" })).toBeTruthy();
  });

  it("locks the 12.8 deploy while the hunt starts", async () => {
    const { user, on128 } = await open("hunt", true);
    const hunt = await screen.findByRole("button", { name: /^Hunt · up to/ });
    await waitFor(() => expect((hunt as HTMLButtonElement).disabled).toBe(false));
    await user.click(hunt);
    await waitFor(() => expect(fakeApi.calls("POST", "/hunt").filter((c) => c.path === "/hunt")).toHaveLength(1));
    await waitFor(() => expect(on128.disabled).toBe(true));
    await user.click(on128);
    expect(fakeApi.calls("POST", "/runpod/deploy")).toHaveLength(0);
  });
});
