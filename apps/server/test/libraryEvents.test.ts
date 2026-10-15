import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { makePng } from "@afflatus/comfy/testing";
import { request } from "node:http";
import type { SystemLoad } from "@afflatus/comfy";
import { libraryFrame, MAX_UNSENT_BYTES, systemFrame } from "../src/events";
import { complete, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

let t: TestApp;
let said: unknown[];
const listen = () => {
  said = [];
  t.services.queue.events.on("library", (c?: unknown) => said.push(libraryFrame(c)));
};
beforeEach(async () => {
  t = await makeApp();
  listen();
});
afterEach(async () => {
  await t.close();
});

const upload = async (name: string, folder?: string) =>
  (await t.app.inject({ method: "POST", url: `/api/assets?name=${encodeURIComponent(name)}${folder ? `&folder=${folder}` : ""}`, headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(16, 16, [1, 2, 3], [4, 5, 6])) })).json();
const last = () => said.at(-1);

describe("a library event", () => {
  it("says what an item's own changes did: added, renamed, kept or not, to the bin and back, erased", async () => {
    const up = await upload("zz-test.png");
    expect(last()).toEqual({ change: "added", items: [up.id], folders: [null] });
    await t.app.inject({ method: "PATCH", url: `/api/assets/${up.id}`, payload: { name: "zz-test renamed" } });
    expect(last()).toEqual({ items: [up.id], change: "fields", name: "zz-test renamed" });
    // kept or not, one at a time (it said nothing before: the other tabs did not hear of it) or several
    await post(t.app, `/api/assets/${up.id}/keep`, { kept: false });
    expect(last()).toEqual({ change: "kept", items: [up.id], kept: false });
    await post(t.app, "/api/assets/bulk", { ids: [up.id], action: "keep" });
    expect(last()).toEqual({ change: "kept", items: [up.id], kept: true, folders: [null] });
    await t.app.inject({ method: "DELETE", url: `/api/assets/${up.id}` });
    expect(last()).toEqual({ change: "binned", items: [up.id], folders: [null] });
    await post(t.app, `/api/assets/${up.id}/restore`);
    expect(last()).toEqual({ change: "binned", items: [up.id], folders: [null] });
    await post(t.app, "/api/assets/bulk", { ids: [up.id], action: "bin" });
    expect(last()).toEqual({ change: "binned", items: [up.id], folders: [null] });
    await post(t.app, "/api/storage/restore-bin");
    expect(last()).toEqual({ change: "binned", items: [up.id], folders: [null] });
    await post(t.app, "/api/assets/bulk", { ids: [up.id], action: "bin" });
    await post(t.app, "/api/storage/empty-bin");
    expect(last()).toEqual({ change: "erased", items: [up.id] });
  });

  it("says which folders a move, an upload into a folder and a folder deleted touched", async () => {
    const folder = (await post(t.app, "/api/folders", { name: "zz-test F", parentId: null })).json();
    expect(last()).toEqual({ change: "places" });
    const up = await upload("zz-test.png");
    await post(t.app, "/api/assets/move", { ids: [up.id], folderId: folder.id });
    // filed in a folder: kept as well
    expect(last()).toEqual({ change: "moved", items: [up.id], folders: [null, folder.id], kept: true });
    await post(t.app, "/api/assets/move", { ids: [up.id], folderId: null });
    expect(last()).toEqual({ change: "moved", items: [up.id], folders: [folder.id, null], kept: false });
    const into = await upload("zz-test 2.png", folder.id);
    expect(last()).toEqual({ change: "added", items: [into.id], folders: [folder.id] });
    await t.app.inject({ method: "PATCH", url: `/api/folders/${folder.id}`, payload: { name: "zz-test G" } });
    expect(last()).toEqual({ change: "places" });
    // what it held moves up to its parent (none here)
    await t.app.inject({ method: "DELETE", url: `/api/folders/${folder.id}` });
    expect(last()).toEqual({ change: "moved", folders: [folder.id, null] });
  });

  it("says a project made or renamed touched only the places, and anything for one archived or deleted", async () => {
    const p = (await post(t.app, "/api/projects", { name: "zz-test P" })).json();
    expect(last()).toEqual({ change: "places" });
    await t.app.inject({ method: "PATCH", url: `/api/projects/${p.id}`, payload: { name: "zz-test Q" } });
    expect(last()).toEqual({ change: "places" });
    // archived: what it holds leaves the lists
    await t.app.inject({ method: "PATCH", url: `/api/projects/${p.id}`, payload: { archived: true } });
    expect(last()).toEqual({});
    await t.app.inject({ method: "DELETE", url: `/api/projects/${p.id}` });
    expect(last()).toEqual({});
  });

  it("goes out as said only when it is one of the known changes, and a list too long to send as any", () => {
    expect(libraryFrame(undefined)).toEqual({});
    expect(libraryFrame({ change: "everything" })).toEqual({});
    expect(libraryFrame({ items: ["a"] })).toEqual({});
    expect(libraryFrame({ change: "kept", items: ["a", 3], kept: "yes" })).toEqual({ change: "kept", items: ["a"] });
    expect(libraryFrame({ change: "moved", folders: ["f", null, 4], kept: true })).toEqual({ change: "moved", folders: ["f", null], kept: true });
    // cut short, the page would take the rest as unchanged
    expect(libraryFrame({ change: "binned", items: Array.from({ length: 201 }, (_x, i) => `i${i}`) })).toEqual({ change: "binned" });
  });
});

describe("a finished render's library event", () => {
  let fake: FakeComfy;
  beforeEach(async () => {
    fake = await makeFake();
    await t.close();
    t = await makeApp({ comfyUrl: fake.url });
    listen();
    await t.services.queue.start();
  });
  afterEach(async () => {
    await fake.close().catch(() => {});
  });

  it("names what it made and the folder it was filed in", async () => {
    await post(t.app, "/api/jobs", job());
    await until(() => fake.prompts.size === 1);
    complete(fake, [...fake.prompts.keys()][0]!);
    await until(() => said.length > 0);
    const made = await t.db.selectFrom("assets").select("id").execute();
    expect(made).toHaveLength(1);
    expect(last()).toEqual({ change: "added", items: [made[0]!.id], folders: [null] });
  });
});

describe("a page that stops reading the live events", () => {
  it("is let go once more than MAX_UNSENT_BYTES wait for it, rather than kept in memory without end", async () => {
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = t.app.server.address() as { port: number };
    // connected, then never read: what is sent piles up in the server's buffer once the socket's own is full
    let closed!: Promise<void>;
    await new Promise<void>((connected) => {
      closed = new Promise<void>((done) => {
        request({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
          res.pause();
          res.socket.on("close", () => done());
          connected();
        }).end();
      });
    });
    const items = Array.from({ length: 200 }, (_, i) => `zz-test-${String(i).padStart(24, "0")}`);
    const frame = JSON.stringify(libraryFrame({ change: "added", items })).length;
    // several times the limit, past what the sockets on both sides hold
    for (let i = 0; i < Math.ceil((40 * MAX_UNSENT_BYTES) / frame); i++) t.services.queue.events.emit("library", { change: "added", items });
    await closed;
  });
});

describe("the machines' load on the live events", () => {
  it("goes out whole as a page opens, then only when a machine's load changed", async () => {
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = t.app.server.address() as { port: number };
    /** The "system" frames a page reads, as they come. */
    const open = () => {
      const frames: unknown[] = [];
      let text = "";
      const req = request({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          for (let end = text.indexOf("\n\n"); end >= 0; end = text.indexOf("\n\n")) {
            const [event, data] = text.slice(0, end).split("\n");
            text = text.slice(end + 2);
            if (event === "event: system") frames.push(JSON.parse(data!.slice(6)));
          }
        });
      });
      req.end();
      return { frames, close: () => req.destroy() };
    };
    const first = open();
    await until(() => first.frames.length > 0);
    expect(first.frames[0]).toMatchObject({ load: null, loads: { m1: null } });
    // two ticks of the load timer with nothing changed (no ComfyUI answers): nothing more is sent
    await new Promise((r) => setTimeout(r, 4_500));
    expect(first.frames).toHaveLength(1);
    // a page opening meanwhile gets it whole at once
    const second = open();
    await until(() => second.frames.length > 0);
    expect(second.frames[0]).toEqual(first.frames[0]);
    first.close();
    second.close();
  });

  it("names the machines whose load changed, and every machine's id", () => {
    const load = (vramPercent: number, at: number): SystemLoad => ({ at, source: "comfyui", disks: [], gpus: [{ name: "GPU", vramUsed: vramPercent, vramTotal: 100, vramPercent }] });
    const opened = systemFrame(new Map(), [{ id: "m1", load: load(10, 1) }, { id: "m2", load: null }]);
    // read again a moment later, the same figures: no frame (the moment it was read aside)
    const same = systemFrame(opened.now, [{ id: "m1", load: load(10, 2) }, { id: "m2", load: null }]);
    expect(same.data).toBeNull();
    expect(systemFrame(same.now, [{ id: "m1", load: load(40, 3) }, { id: "m2", load: null }]).data).toEqual({ machines: ["m1", "m2"], loads: { m1: load(40, 3) } });
    // a machine gone: the ids say so
    expect(systemFrame(same.now, [{ id: "m1", load: load(10, 3) }]).data).toEqual({ machines: ["m1"], loads: {} });
  });
});
