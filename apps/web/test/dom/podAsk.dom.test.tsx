import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { QueueStatus, RecipeInfo } from "../../src/api";
import { queryKeys } from "../../src/queryKeys";
import { fakeApi } from "./fakeApi";

const asked = vi.hoisted(() => vi.fn(async () => false));
vi.mock("../../src/Confirm", () => ({ ask: asked }));
const { askBeforeMany } = await import("../../src/podAsk");

/**
 * A pass or a Vary ×N on a library selection (the 2026-11-05 review, M2): 300 pictures × 8 were queued onto a pod without a
 * word. They are asked about as a grid is, priced on every pod set up, a stopped one too.
 */
const recipe = { id: "sdxl.redraw", title: "img2img" } as RecipeInfo;
const pod = (status: string) => ({ id: "pod-1", pace: 1, rented: { rate: 0.9, status } });
const withPods = (client: QueryClient, status = "RUNNING") =>
  client.setQueryData(queryKeys.queue(), { running: null, waiting: [], recent: [], machines: [{ id: "m1", pace: 1, rented: null }, pod(status)] } as unknown as QueueStatus);

describe("many renders where a pod may take them", () => {
  it("are asked about above the grid's threshold, a stopped pod counted", async () => {
    // 20 s a render: 2,400 of them are over 13 h, about $12 at $0.90 an hour
    fakeApi.on("POST /advice", { estimate: { ms: 20_000, loadMs: 0, on: null, loadOn: null, auto: null } });
    fakeApi.on("GET /rented/spending", { spending: { today: 0, month: 0, monthVolumes: null, caps: { day: 0, month: 0 }, balance: null } });
    const client = new QueryClient();
    withPods(client, "EXITED");
    expect(await askBeforeMany(client, { recipe, input: {}, total: 2_400, what: "Vary strong ×8 on 300 pictures" })).toBe(false);
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^Queue 2,?400 renders where a pod may take them\?$/), text: expect.stringMatching(/^Vary strong ×8 on 300 pictures\. About \$12\.00 on the pod\.$/) }));
  });

  it("are queued at once off pods, and under the threshold", async () => {
    asked.mockClear();
    fakeApi.on("POST /advice", { estimate: { ms: 20_000, loadMs: 0, on: null, loadOn: null, auto: null } });
    fakeApi.on("GET /rented/spending", { spending: { today: 0, month: 0, monthVolumes: null, caps: { day: 0, month: 0 }, balance: null } });
    const client = new QueryClient();
    client.setQueryData(queryKeys.queue(), { running: null, waiting: [], recent: [], machines: [] } as unknown as QueueStatus);
    expect(await askBeforeMany(client, { recipe, input: {}, total: 2_400, what: "x" })).toBe(true);
    withPods(client);
    expect(await askBeforeMany(client, { recipe, input: {}, total: 10, what: "x" })).toBe(true);
    expect(asked).not.toHaveBeenCalled();
  });
});
