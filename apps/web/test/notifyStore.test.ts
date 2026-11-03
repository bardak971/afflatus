import { describe, expect, it } from "vitest";
import { useNotify } from "../src/store";

/** This browser's notification ticks, per kind since the server's notices (notify.ts). */

describe("this browser's notification ticks", () => {
  it("set one kind without touching the others or the banner", () => {
    useNotify.getState().set({ browser: { renderDone: true, queueEmpty: true } });
    useNotify.getState().set({ browser: { renderDone: false } });
    expect(useNotify.getState()).toMatchObject({ banner: true, browser: { renderDone: false, queueEmpty: true } });
    useNotify.getState().set({ banner: false });
    expect(useNotify.getState()).toMatchObject({ banner: false, browser: { renderDone: false, queueEmpty: true } });
  });
});
