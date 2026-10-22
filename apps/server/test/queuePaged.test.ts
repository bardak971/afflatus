import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { paged, WAITING_SHOWN, type RentedRow } from "../src/queueView";
import { get, job, makeApp, makeFake, post, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

describe("the queue's answer, paged", () => {
  it("carries the first waiting jobs whole and the others in a few figures, and their whole rows a page at a time", async () => {
    await post(t.app, "/api/queue/pause");
    const ids: string[] = [];
    for (let i = 0; i < WAITING_SHOWN + 7; i++) ids.push(...(await post(t.app, "/api/jobs", job({ prompt: `zz-test ${i}` }))).json().ids);
    const q = (await get(t.app, "/api/queue")).json();
    expect(q.waiting).toHaveLength(WAITING_SHOWN);
    expect(q.waitingCount).toBe(WAITING_SHOWN + 7);
    expect([...q.waiting, ...q.later].map((w: { id: string }) => w.id)).toEqual(ids);
    // a later one: what the screens count, find and order it by, no more
    // (those it has none of left out: no clip, no draft, not pinned, paused so no plan)
    expect(Object.keys(q.later[0]).sort()).toEqual(["id", "kind", "label", "recipe"].concat(q.later[0].estimateMs ? ["estimateMs"] : []).sort());
    const page = (await get(t.app, `/api/queue/waiting?offset=${WAITING_SHOWN}&limit=5`)).json();
    expect(page.count).toBe(WAITING_SHOWN + 7);
    expect(page.items.map((w: { id: string }) => w.id)).toEqual(ids.slice(WAITING_SHOWN, WAITING_SHOWN + 5));
    expect(page.items[0]).toHaveProperty("createdAt");
    // the routes that change the line answer the same way
    const reordered = (await post(t.app, "/api/queue/order", { ids: [ids.at(-1)!] })).json();
    expect(reordered.waiting[0].id).toBe(ids.at(-1));
    expect(reordered.later).toHaveLength(7);
  });

  it("says a rented pod's figures that move with the clock so that the same state is the same bytes", () => {
    const rented = { idleLeftMs: 600_000, spent: 0.123456 } as unknown as RentedRow;
    const status = { waiting: [], machines: [{ id: "rp", rented }] };
    const a = paged(status);
    const b = paged(status);
    expect(a.machines[0]!.rented).toMatchObject({ spent: 0.12 });
    expect(a.machines[0]!.rented).not.toHaveProperty("idleLeftMs");
    const at = a.machines[0]!.rented!.idleAt!;
    expect(Math.abs(at - (Date.now() + 600_000))).toBeLessThan(1500);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("leaves out the waiting rows a read holds, while they are unchanged, and sends them again once they change", async () => {
    await post(t.app, "/api/queue/pause");
    const ids: string[] = [];
    for (let i = 0; i < WAITING_SHOWN + 3; i++) ids.push(...(await post(t.app, "/api/jobs", job({ prompt: `zz-test ${i}` }))).json().ids);
    const whole = await get(t.app, "/api/queue");
    const q = whole.json();
    expect(q.same).toEqual([]);
    expect(q.waiting).toHaveLength(WAITING_SHOWN);
    // read again naming both parts: neither is sent, and the answer is a fraction of the bytes
    const again = await get(t.app, `/api/queue?have=${q.parts.waiting},${q.parts.later}`);
    const a = again.json();
    expect(a.same).toEqual(["waiting", "later"]);
    expect(a.waiting).toEqual([]);
    expect(a.later).toEqual([]);
    expect(a.parts).toEqual(q.parts);
    expect(a.waitingCount).toBe(WAITING_SHOWN + 3);
    expect(again.body.length).toBeLessThan(whole.body.length / 4);
    // the last one cancelled: the later rows changed and are sent, the whole ones did not
    await post(t.app, `/api/jobs/${ids.at(-1)}/cancel`);
    const b = (await get(t.app, `/api/queue?have=${q.parts.waiting},${q.parts.later}`)).json();
    expect(b.same).toEqual(["waiting"]);
    expect(b.later.map((w: { id: string }) => w.id)).toEqual(ids.slice(WAITING_SHOWN, -1));
    expect(b.parts.later).not.toBe(q.parts.later);
    // a hash the read does not hold for the part sends it whole
    expect((await get(t.app, "/api/queue?have=nothing")).json()).toMatchObject({ same: [], waiting: q.waiting });
  });

  it("answers 304 to a read of a queue that did not change", async () => {
    await post(t.app, "/api/queue/pause");
    await post(t.app, "/api/jobs", job({ prompt: "zz-test" }));
    const first = await get(t.app, "/api/queue");
    const again = await t.app.inject({ method: "GET", url: "/api/queue", headers: { "if-none-match": String(first.headers.etag) } });
    expect(again.statusCode).toBe(304);
  });
});
