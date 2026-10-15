import { describe, expect, it, vi } from "vitest";

// timingSafeEqual watched: the token of a download's address is compared by it, never by !== (which stops at the first wrong character)
const compared = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return {
    ...real,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compared.count++;
      return real.timingSafeEqual(a, b);
    },
  };
});

const { sameToken } = await import("../src/downloads");

describe("the token of a download's one-time address", () => {
  it("is compared in constant time, whatever its length", () => {
    const want = "a".repeat(48);
    compared.count = 0;
    expect(sameToken(want, want)).toBe(true);
    expect(sameToken(`${"a".repeat(47)}b`, want)).toBe(false);
    expect(sameToken("a", want)).toBe(false);
    expect(sameToken("", want)).toBe(false);
    expect(compared.count).toBe(4);
    // what is no token, and a download without one, never match
    expect(sameToken(undefined, want)).toBe(false);
    expect(sameToken(["a".repeat(48)], want)).toBe(false);
    expect(sameToken("", "")).toBe(false);
  });
});
