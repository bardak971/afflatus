import { afterEach, describe, expect, it } from "vitest";
import { get, makeApp, type TestApp } from "./helpers";

let t: TestApp;
afterEach(async () => t?.close());

const put = (url: string, payload: object) => t.app.inject({ method: "PUT", url, payload });
const placesNow = async () => (await get(t.app, "/api/settings")).json().downloadPlaces;

/** The places chosen for downloads (card #59) of a machine that is gone: a terminated pod, a ComfyUI taken out of Settings. */
describe("a removed machine's download places", () => {
  it("are reset without asking its ComfyUI, which no longer answers or no longer exists", async () => {
    t = await makeApp();
    await put("/api/settings", { machines: [{ id: "m1", url: "http://127.0.0.1:9" }] });
    await put("/api/settings", { downloadPlaces: { m1: { loras: "C:\ComfyUI\models\loras" }, gone: { loras: "/workspace/extra/loras", vae: "/workspace/extra/vae" } } });
    const res = await put("/api/downloads/places", { machine: "gone", folder: "loras", path: null });
    expect(res.statusCode).toBe(200);
    expect(await placesNow()).toEqual({ m1: { loras: "C:\ComfyUI\models\loras" }, gone: { vae: "/workspace/extra/vae" } });
    // choosing one still needs its ComfyUI to say it reads from there
    expect((await put("/api/downloads/places", { machine: "gone", folder: "loras", path: "/workspace/extra/loras" })).statusCode).toBe(409);
  });

  it("go with the machine when it is taken out", async () => {
    t = await makeApp();
    await put("/api/settings", { machines: [{ id: "m1", url: "http://127.0.0.1:9" }, { id: "m2", url: "http://127.0.0.1:10" }] });
    await put("/api/settings", { downloadPlaces: { m1: { loras: "C:\a" }, m2: { loras: "D:\b" } } });
    await put("/api/settings", { machines: [{ id: "m1", url: "http://127.0.0.1:9" }] });
    expect(await placesNow()).toEqual({ m1: { loras: "C:\a" } });
  });
});
