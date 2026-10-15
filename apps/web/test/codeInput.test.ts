import { describe, expect, it } from "vitest";
import { codeOf, codeShown } from "../src/access/codeInput";

/** The reset code's field (access/SignIn.tsx): upper case, grouped after five, a paste taken with or without its dash. */
describe("the code's field", () => {
  it("groups what is typed, upper case", () => {
    expect(codeShown("k7m2")).toBe("K7M2");
    expect(codeShown("k7m2p")).toBe("K7M2P");
    expect(codeShown("k7m2p9")).toBe("K7M2P-9");
    expect(codeShown("K7M2P-9XQ4R")).toBe("K7M2P-9XQ4R");
  });

  it("takes a paste with or without the dash or spaces, and drops what cannot be a code", () => {
    expect(codeShown(" k7m2p 9xq4r ")).toBe("K7M2P-9XQ4R");
    expect(codeShown("K7M2P9XQ4R")).toBe("K7M2P-9XQ4R");
    expect(codeShown("K7M2P-9XQ4R-EXTRA")).toBe("K7M2P-9XQ4R");
    expect(codeShown("u!?")).toBe("");
  });

  it("reads I and L as 1 and O as 0, as the server does", () => {
    expect(codeOf("ILOAB-CDEFG")).toBe("110ABCDEFG");
  });

  it("makes a code only with all ten", () => {
    expect(codeOf("K7M2P-9XQ4R")).toBe("K7M2P9XQ4R");
    expect(codeOf("K7M2P-9XQ4")).toBeNull();
  });
});
