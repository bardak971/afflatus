import { describe, expect, it } from "vitest";
import { capAmount, capRefusal } from "../src/screens/settings/capAmount";

/** A spending cap as typed in its box (Settings › Rented GPUs): read as the one amount it means, or refused. */

describe("a cap typed in its box", () => {
  it("reads a plain amount, with or without its sign and spaces", () => {
    expect(capAmount("5")).toBe(5);
    expect(capAmount(" $12.50 ")).toBe(12.5);
    expect(capAmount(".5")).toBe(0.5);
    expect(capAmount("0.125")).toBe(0.125);
  });

  it("is no cap when empty", () => {
    expect(capAmount("")).toBe(0);
    expect(capAmount("  $ ")).toBe(0);
  });

  it("reads a thousands separator as one, never as the decimal point", () => {
    expect(capAmount("1,000")).toBe(1000);
    expect(capAmount("$1,250.50")).toBe(1250.5);
    expect(capAmount("12,000,000")).toBe(12_000_000);
    expect(capAmount("1.000,50")).toBe(1000.5);
    expect(capAmount("1 000 $")).toBe(1000);
  });

  it("reads a comma followed by one or two digits as the decimals", () => {
    expect(capAmount("2,5")).toBe(2.5);
    expect(capAmount("12,50")).toBe(12.5);
  });

  it("refuses what could be two amounts, or none", () => {
    // a thousand the European way, or one dollar: never guessed
    expect(capAmount("1.000")).toBeNull();
    expect(capAmount("10.000")).toBeNull();
    expect(capAmount("1,0000")).toBeNull();
    expect(capAmount("1,000,5")).toBeNull();
    expect(capAmount("-5")).toBeNull();
    expect(capAmount("five")).toBeNull();
    expect(capAmount("5$5")).toBeNull();
  });

  it("refuses an amount in another currency: caps are US dollars, as RunPod bills", () => {
    expect(capAmount("€50")).toBeNull();
    expect(capAmount("50 €")).toBeNull();
    expect(capAmount("£5")).toBeNull();
    expect(capRefusal("€50")).toMatch(/US dollars/);
  });

  it("refuses a typed 0, which would be no cap, the opposite of stopping all spending", () => {
    expect(capAmount("0")).toBeNull();
    expect(capAmount("$0.00")).toBeNull();
    expect(capAmount("0,0")).toBeNull();
    expect(capRefusal("0")).toMatch(/above \$0/);
    expect(capRefusal("five")).toMatch(/not one amount/);
  });
});
