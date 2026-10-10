import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng } from "@afflatus/comfy/testing";
import { libraryFrame } from "../src/events";
import { makeApp, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

describe("a library event", () => {
  it("says what changed when its sender knows: a rename touches the item's fields alone, a project made only the places", async () => {
    const said: unknown[] = [];
    t.services.queue.events.on("library", (c?: unknown) => said.push(libraryFrame(c)));
    const up = (await t.app.inject({ method: "POST", url: "/api/assets?name=zz-test.png", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(16, 16, [1, 2, 3], [4, 5, 6])) })).json();
    // an item that came: every list
    expect(said.at(-1)).toEqual({});
    await t.app.inject({ method: "PATCH", url: `/api/assets/${up.id}`, payload: { name: "zz-test renamed" } });
    expect(said.at(-1)).toEqual({ items: [up.id], change: "fields" });
    const p = (await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "zz-test P" } })).json();
    expect(said.at(-1)).toEqual({ change: "places" });
    await t.app.inject({ method: "PATCH", url: `/api/projects/${p.id}`, payload: { name: "zz-test Q" } });
    expect(said.at(-1)).toEqual({ change: "places" });
    // archived: what it holds leaves the lists
    await t.app.inject({ method: "PATCH", url: `/api/projects/${p.id}`, payload: { archived: true } });
    expect(said.at(-1)).toEqual({});
  });

  it("goes out as said only when it is one of the known changes", () => {
    expect(libraryFrame(undefined)).toEqual({});
    expect(libraryFrame({ change: "everything" })).toEqual({});
    expect(libraryFrame({ items: ["a"] })).toEqual({});
    expect(libraryFrame({ change: "kept", items: ["a", 3] })).toEqual({ change: "kept", items: ["a"] });
  });
});
