import { describe, expect, it } from "vitest";
import { crashLine, memoryLine } from "../src/processWatch";

const GB = 2 ** 30;

describe("what the server says about itself for the log", () => {
  it("says a crash with its time, how it came, and the stack", () => {
    const line = crashLine(new Error("zz-test boom"), "uncaughtException", new Date("2026-11-10T09:30:00.000Z"));
    expect(line).toMatch(/^\[crash\] 2026-11-10T09:30:00\.000Z Afflatus's server stopped on an uncaught exception:\nError: zz-test boom\n\s+at /);
    expect(crashLine("zz-test thrown string", "unhandledRejection")).toMatch(/a promise rejected with no one to catch it:\nzz-test thrown string$/);
  });

  it("says the memory held from 2 GB, once for each new whole gigabyte", () => {
    expect(memoryLine(1.9 * GB, 0, 16 * GB)).toBeNull();
    expect(memoryLine(2.3 * GB, 0, 16 * GB)).toEqual({ line: "[memory] the server holds 2.3 GB, the most this run (of the 16 GB this computer has)", said: 2 });
    expect(memoryLine(2.9 * GB, 2, 16 * GB)).toBeNull();
    expect(memoryLine(3.1 * GB, 2, 16 * GB)?.said).toBe(3);
    // down and up again: said only past the most said
    expect(memoryLine(2.5 * GB, 3, 16 * GB)).toBeNull();
  });
});
