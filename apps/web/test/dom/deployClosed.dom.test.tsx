import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { DeployHost, openDeploy } from "../../src/deploy";
import { useBanners } from "../../src/store";
import { fakeApi, jsonAnswer, later } from "./fakeApi";
import { draw } from "./render";

/**
 * The Deploy dialog closed (Esc, Cancel) while "Deploying…": what RunPod answered is still said, in a banner since the
 * dialog's own note went with it, and a pod made meanwhile moves no one to its card.
 */

const lastDeploy = { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 120, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15, set: "", files: [], leaveOut: [], accept: [], again: false, makeRoom: true };

function serve() {
  fakeApi.on("GET /settings", { hasRunpodKey: false, machines: [], lastDeploy });
  fakeApi.on("GET /runpod/gpus", { gpus: [{ id: "NVIDIA A40", name: "A40", memory: 48, price: 0.4, availability: "HIGH", dataCenters: [{ id: "EU-RO-1", availability: "HIGH" }] }] });
  fakeApi.on("GET /runpod/images", { afflatus: true, runpod: true });
  const answer = later<Response | object>();
  fakeApi.on("POST /runpod/deploy", () => answer.promise);
  return answer;
}

/** The dialog opened, Deploy pressed, then closed with Esc while the deploy is under way. */
async function deployThenClose() {
  const answer = serve();
  const drawn = draw(<DeployHost />, { at: "/studio" });
  // the dialog starts from the last deploy's choices, as the settings say them once read
  await drawn.client.prefetchQuery({ queryKey: ["settings"], queryFn: () => fetch("/api/settings").then((r) => r.json()) });
  act(() => openDeploy());
  const button = await screen.findByRole("button", { name: /^Deploy · / }, { timeout: 5000 });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  await drawn.user.click(button);
  await waitFor(() => expect(fakeApi.calls("POST", "/runpod/deploy")).toHaveLength(1));
  await drawn.user.click(screen.getByRole("button", { name: /Cancel/ }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /Deploying/ })).toBeNull());
  return { ...drawn, answer };
}

describe("the Deploy dialog closed while it deploys", () => {
  it("says a refusal in a banner", async () => {
    const { answer } = await deployThenClose();
    await act(async () => answer.answer(jsonAnswer({ error: "RunPod has no A40 free in EU-RO-1 now" }, 409)));
    await waitFor(() => expect(useBanners.getState().items.map((b) => b.title)).toContain("Not deployed"));
    expect(useBanners.getState().items.find((b) => b.title === "Not deployed")?.text).toMatch(/no A40 free/);
  });

  it("says a pod made meanwhile, and leaves the user where they are", async () => {
    const { answer, location } = await deployThenClose();
    await act(async () => answer.answer({ id: "rp-new" }));
    await waitFor(() => expect(useBanners.getState().items.map((b) => b.title)).toContain("Deployed"));
    expect(location.history?.at(-1)).toBe("/studio");
  });
});
