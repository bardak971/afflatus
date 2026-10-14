import { describe, expect, it } from "vitest";
import { notifyMigrate, useNotify } from "../src/store";

/** This browser's notification ticks, per kind since the server's notices (notify.ts): the two switches of before carried over. */

describe("this browser's notification ticks", () => {
  it("carry the two switches of before over: after each render is a render done or failed, the queue's own is the queue empty", () => {
    expect(notifyMigrate({ eachRender: true, whenEmpty: false, banner: false }, 0)).toEqual({ banner: false, browser: { renderDone: true, renderFailed: true, queueEmpty: false } });
    expect(notifyMigrate({ eachRender: false, whenEmpty: true }, 0)).toEqual({ banner: true, browser: { renderDone: false, renderFailed: false, queueEmpty: true } });
    // nothing kept yet: everything off, the banner on
    expect(notifyMigrate(undefined, 0)).toEqual({ banner: true, browser: { renderDone: false, renderFailed: false, queueEmpty: false } });
    // already per kind: kept as it is
    expect(notifyMigrate({ banner: true, browser: { comfyGone: true } }, 1)).toEqual({ banner: true, browser: { comfyGone: true } });
  });

  it("set one kind without touching the others or the banner", () => {
    useNotify.getState().set({ browser: { renderDone: true, queueEmpty: true } });
    useNotify.getState().set({ browser: { renderDone: false } });
    expect(useNotify.getState()).toMatchObject({ banner: true, browser: { renderDone: false, queueEmpty: true } });
    useNotify.getState().set({ banner: false });
    expect(useNotify.getState()).toMatchObject({ banner: false, browser: { renderDone: false, queueEmpty: true } });
  });
});
