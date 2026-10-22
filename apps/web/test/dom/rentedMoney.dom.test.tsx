import { beforeAll, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Machine, MachineState } from "../../src/api";
import { ConfirmHost } from "../../src/Confirm";
import { loadConfirmDialog } from "../../src/lazyParts";
import { MachineMenuBody } from "../../src/MachineMenu";
import { MachineCard, SetAsideNote } from "../../src/screens/settings/MachinesCard";
import { RentedTab } from "../../src/screens/settings/RentedCard";
import { useRentedOps } from "../../src/rentedOps";
import { useBanners } from "../../src/store";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

/**
 * The money controls of the web app, drawn: the spending caps' boxes, a gone pod's Remove, the menu's Start and Stop of a
 * pod, and what a refused Stop says. Nothing reaches RunPod: the server is the stand-in (fakeApi).
 */

const rented = (over: Partial<NonNullable<MachineState["rented"]>> = {}) => ({
  provider: "runpod", pod: "p1", status: "RUNNING", rate: 0.69, gpuRate: null, gpu: "NVIDIA A40", dataCenter: "EU-RO-1", since: Date.now() - 60_000, spent: 0,
  diskPerDay: 0.33, volume: false, otherPorts: [], closedPorts: [], watchdog: "on", answers: true, idleAt: null, capped: false, stopping: false, stoppedBy: null,
  booting: false, boot: null, error: null, files: [], packs: [], disk: null, ...over,
}) as unknown as NonNullable<MachineState["rented"]>;

const state = (id: string, name: string, over: Partial<MachineState> = {}): MachineState => ({
  id, name, url: `https://${id}-8188.proxy.runpod.net`, takes: "all", paused: false, online: true, locked: true, rented: rented(), model: null, pace: null, running: null, ...over,
} as MachineState);

const machine = (id: string, name: string, over: Partial<NonNullable<Machine["rented"]>> = {}): Machine => ({
  id, name, url: `https://${id}-8188.proxy.runpod.net`, dir: "", takes: "all", packs: "ask", families: {}, tokenEnd: "",
  rented: { provider: "runpod", pod: `pod-${id}`, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15, openPorts: false, closedPorts: [], secret: "", deployed: true, deployedAt: "", userStopped: false, makeRoom: false, ...over } as NonNullable<Machine["rented"]>,
});

const home: Machine = { id: "m1", name: "", url: "http://127.0.0.1:8188", dir: "", takes: "all", packs: "ask", families: {}, tokenEnd: "" };

function serveQueue(machines: MachineState[]) {
  fakeApi.on("GET /queue", { online: true, paused: false, running: null, waiting: [], later: [], recent: [], machines });
}

beforeAll(() => loadConfirmDialog());

describe("the spending caps' boxes", () => {
  const settings = { hasRunpodKey: true, rentCaps: { day: 0, month: 0 }, machines: [home], volumeUnusedDays: 7, lastDeploy: null };

  it("reads 1,000 as a thousand dollars, never as $1", async () => {
    fakeApi.on("GET /settings", settings);
    fakeApi.on("PUT /settings", ({ body }) => ({ ...settings, ...(body as object) }));
    const { user } = draw(<RentedTab />);
    const month = await screen.findByLabelText("Cap a month");
    await user.type(month, "1,000");
    await user.tab();
    await waitFor(() => expect(fakeApi.calls("PUT", "/settings")).toHaveLength(1));
    expect(fakeApi.calls("PUT", "/settings")[0]!.body).toEqual({ rentCaps: { day: 0, month: 1000 } });
  });

  it("shows the cap as saved again when its save failed, and says which cap was not saved", async () => {
    fakeApi.on("GET /settings", settings);
    fakeApi.on("PUT /settings", () => jsonAnswer({ error: "the settings could not be written" }, 500));
    const { user } = draw(<RentedTab />);
    const day = await screen.findByLabelText("Cap a day");
    await user.type(day, "5");
    await user.tab();
    await waitFor(() => expect(screen.getByText(/The day cap was not saved \(still none\)/)).toBeTruthy());
    // the box no longer shows $5 as if it were in force
    expect((screen.getByLabelText("Cap a day") as HTMLInputElement).value).toBe("");
    // a month cap saved after it does not take the day's note away: the day still has no cap
    fakeApi.on("PUT /settings", ({ body }) => ({ ...settings, ...(body as object) }));
    await user.type(screen.getByLabelText("Cap a month"), "40");
    await user.tab();
    await waitFor(() => expect(fakeApi.calls("PUT", "/settings").at(-1)!.body).toEqual({ rentCaps: { day: 0, month: 40 } }));
    expect(screen.getByText(/The day cap was not saved/)).toBeTruthy();
  });
});

describe("a pod gone from RunPod, on its card", () => {
  it("is removed from Afflatus by its own route, not by a whole-list save the server would keep it through", async () => {
    const pod = machine("rp-1", "A40");
    fakeApi.on("GET /settings", { hasRunpodKey: true, machines: [home, pod], rentCaps: { day: 0, month: 0 } });
    fakeApi.on("POST /machines/:id/remove", { ok: true });
    fakeApi.on("PUT /settings", { machines: [home, pod] });
    const gone = state("rp-1", "A40", { online: false, rented: rented({ status: "GONE" }) });
    const { user } = draw(<MachineCard machine={pod} index={1} probe={undefined} state={gone} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove from Afflatus" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Remove from Afflatus" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/machines/rp-1/remove")).toHaveLength(1));
    expect(fakeApi.calls("PUT", "/settings")).toHaveLength(0);
  });
});

describe("a pod's Start and Stop from its menu", () => {
  it("asks before stopping a pod that renders, and says its render is lost", async () => {
    const pod = state("rp-1", "A40", { running: { id: "j1", progress: 0.4 } as MachineState["running"] });
    serveQueue([state("m1", ""), pod]);
    fakeApi.on("GET /settings", { machines: [home, machine("rp-1", "A40")] });
    fakeApi.on("POST /machines/:id/stop", rented({ status: "EXITED" }));
    const { user } = draw(<><MachineMenuBody at={{ x: 10, y: 10 }} machine="rp-1" onClose={() => {}} /><ConfirmHost /></>);
    await user.click(await screen.findByRole("menuitem", { name: /Stop A40/ }));
    const question = await screen.findByRole("dialog");
    expect(within(question).getByText(/The render on it is lost/)).toBeTruthy();
    expect(fakeApi.calls("POST", "/machines/rp-1/stop")).toHaveLength(0);
    await user.click(within(question).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/machines/rp-1/stop")).toHaveLength(1));
  });

  it("asks before starting one, with its rate and that it never stops when idle", async () => {
    serveQueue([state("m1", ""), state("rp-1", "A40", { online: false, rented: rented({ status: "EXITED" }) })]);
    fakeApi.on("GET /settings", { machines: [home, machine("rp-1", "A40", { idleMinutes: 0 })] });
    fakeApi.on("POST /machines/:id/start", rented());
    const { user, client } = draw(<><MachineMenuBody at={{ x: 10, y: 10 }} machine="rp-1" onClose={() => {}} /><ConfirmHost /></>);
    await client.prefetchQuery({ queryKey: ["settings"], queryFn: () => fetch("/api/settings").then((r) => r.json()) });
    await user.click(await screen.findByRole("menuitem", { name: /Start A40/ }));
    const question = await screen.findByRole("dialog");
    expect(within(question).getByText(/\$0\.69 \/ h from now · never stops when idle/)).toBeTruthy();
    expect(fakeApi.calls("POST", "/machines/rp-1/start")).toHaveLength(0);
    await user.click(within(question).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/machines/rp-1/start")).toHaveLength(1));
  });
});

describe("a refused Stop", () => {
  /** Stops each pod as Stop all pods does, one after the other. */
  function StopAll({ ids }: { ids: string[] }) {
    const ops = useRentedOps();
    return <button type="button" onClick={async () => { for (const machine of ids) await ops.stop.mutateAsync({ machine, how: "stop" }).catch(() => {}); }}>Stop all</button>;
  }

  it("names the pod that still bills, one banner for each", async () => {
    serveQueue([state("rp-1", "A40"), state("rp-2", "RTX 5090")]);
    fakeApi.on("POST /machines/:id/stop", () => jsonAnswer({ error: "RunPod did not answer" }, 502));
    const { user, client } = draw(<StopAll ids={["rp-1", "rp-2"]} />);
    await client.prefetchQuery({ queryKey: ["queue"], queryFn: () => fetch("/api/queue").then((r) => r.json()) });
    await user.click(screen.getByRole("button", { name: "Stop all" }));
    await waitFor(() => expect(useBanners.getState().items).toHaveLength(2));
    expect(useBanners.getState().items.map((b) => b.title)).toEqual(["Could not stop A40", "Could not stop RTX 5090"]);
    // the same pod refused again: its banner said anew, not one more
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop all" })));
    await waitFor(() => expect(fakeApi.calls("POST", "/machines/").length).toBe(4));
    expect(useBanners.getState().items).toHaveLength(2);
  });
});

describe("the note of a stored machine that could not be read", () => {
  const aside = { key: "0123456789abcdef", label: "pod-x", mended: false, fields: [], now: [], pod: true, why: "url: Invalid URL" };
  const mended = { key: "fedcba9876543210", label: "pod-y", mended: true, fields: ["rented.idleDo"], now: ["idleDo: terminate"], pod: true, why: "" };

  it("forgets an unreadable pod only once told it still bills, and says what a mended one runs on meanwhile", async () => {
    fakeApi.on("GET /settings", { machines: [home], machinesSetAside: [aside, mended] });
    fakeApi.on("POST /machines/set-aside/forget", ({ body }) => ((body as { anyway?: boolean }).anyway ? { ok: true } : jsonAnswer({ error: "Its pod p1 still runs on RunPod, billed." }, 409)));
    const { user } = draw(<><SetAsideNote /><ConfirmHost /></>);
    expect(await screen.findByText(/Meanwhile it runs on the default \(idleDo: terminate\)/)).toBeTruthy();
    // one button, for the unreadable one only
    expect(screen.getAllByRole("button", { name: /Forget this unreadable entry/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /Forget this unreadable entry/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/machines/set-aside/forget")).toHaveLength(1));
    expect(fakeApi.calls("POST", "/machines/set-aside/forget")[0]!.body).toEqual({ key: aside.key, anyway: false });
    // the server's word that its pod bills, asked again before it goes
    const again = await screen.findByRole("dialog");
    expect(within(again).getByText(/still runs on RunPod/)).toBeTruthy();
    await user.click(within(again).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/machines/set-aside/forget")).toHaveLength(2));
    expect(fakeApi.calls("POST", "/machines/set-aside/forget")[1]!.body).toEqual({ key: aside.key, anyway: true });
  });
});
