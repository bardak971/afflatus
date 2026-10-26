import { beforeAll, describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { ConfirmHost } from "../../src/Confirm";
import { DeployHost, useDeployAgain } from "../../src/deploy";
import { usd } from "../../src/format";
import { loadConfirmDialog } from "../../src/lazyParts";
import { diskPerHour } from "../../src/machines";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * "Deploy again" (money): its question says the pod's rate as the Deploy dialog does (the GPU and its disk), and a GPU free
 * only on hosts too old for the CUDA 13.0 build asked for opens the dialog (which offers 12.8) rather than a deploy the
 * server refuses.
 */

const lastDeploy = { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", cuda: "13.0", volume: "", disk: 120, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15, set: "", files: [], leaveOut: [], accept: [], again: false, makeRoom: true };
const a40 = (cuda13: boolean) => ({ id: "NVIDIA A40", name: "A40", memory: 48, price: 0.4, availability: "HIGH", cuda13, dataCenters: [{ id: "EU-RO-1", availability: "HIGH" }] });

function Again() {
  const { last, run } = useDeployAgain();
  return <button type="button" disabled={!last} onClick={() => run.mutate()}>Deploy again</button>;
}

async function press(cuda13: boolean) {
  fakeApi.on("GET /settings", { hasRunpodKey: true, machines: [], lastDeploy });
  fakeApi.on("GET /runpod/gpus", { gpus: [a40(cuda13)] });
  fakeApi.on("GET /runpod/images", { afflatus: true, runpod: true });
  fakeApi.on("GET /runpod/volumes", { volumes: [] });
  fakeApi.on("POST /hunt/rank", { ranking: [], held: 2, overhead: null });
  fakeApi.on("POST /runpod/deploy", { id: "rp-new" });
  const drawn = draw(<><Again /><ConfirmHost /><DeployHost /></>, { at: "/queue" });
  const again = await screen.findByRole("button", { name: "Deploy again" });
  await waitFor(() => expect((again as HTMLButtonElement).disabled).toBe(false));
  await act(async () => drawn.user.click(again));
  return drawn;
}

beforeAll(() => loadConfirmDialog());

describe("Deploy again", () => {
  it("says the GPU's rate with its disk, as the Deploy dialog does", async () => {
    await press(true);
    await screen.findByText("Deploy another A40?");
    const rate = usd(0.4 + diskPerHour(120));
    expect(rate).not.toBe(usd(0.4));
    expect(screen.getByText(new RegExp(`on RunPod at \\${rate}/h`))).toBeTruthy();
    expect(screen.queryByText(/on RunPod at \$0\.40\/h/)).toBeNull();
  });

  it("opens the dialog when no host of the GPU free has CUDA 13, rather than asking for a deploy the server refuses", async () => {
    await press(false);
    expect(await screen.findByRole("button", { name: /^Deploy on CUDA 12\.8/ }, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText("Deploy another A40?")).toBeNull();
    expect(fakeApi.calls("POST", "/runpod/deploy")).toEqual([]);
  });
});
