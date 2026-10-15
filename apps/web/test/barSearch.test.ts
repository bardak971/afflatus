import { describe, expect, it } from "vitest";
import { completeLast, isRenderSearch, keysFor, parseSearch, sinceOf, valueText, without } from "../src/bar/search";

const keys = (line: string, models?: string[]) => parseSearch(line, models).tokens.map((t) => `${t.not ? "-" : ""}${t.key}${t.value ? `=${t.value}` : ""}${t.guessed ? "?" : ""}`);

describe("the render search's grammar", () => {
  it("reads keys and the words left, in any order", () => {
    expect(keys("video: harbor")).toEqual(["video"]);
    expect(parseSearch("video: harbor").words).toBe("harbor");
    expect(keys("image: lora:dasiwa_v2 kept since:3d")).toEqual(["image", "lora=dasiwa_v2", "kept", "since=3d"]);
    expect(keys('prompt:"red bicycle" klein', ["klein"])).toEqual(["prompt=red bicycle", "model=klein?"]);
    expect(parseSearch('prompt:"red bicycle" studio').words).toBe("studio");
  });

  it("leaves out with a minus, and reads expiring as not kept", () => {
    expect(keys("-kept in:Showcase")).toEqual(["-kept", "in=Showcase"]);
    expect(keys("expiring")).toEqual(["-kept"]);
    expect(keys("-lora:grain")).toEqual(["-lora=grain"]);
  });

  it("keeps a word that only looks like a key: an unknown key, a minus alone", () => {
    expect(keys("http://x foo:bar - x")).toEqual([]);
    expect(parseSearch("foo:bar - x").words).toBe("foo:bar - x");
  });

  it("is a render search only with a key typed, not a guessed one", () => {
    expect(isRenderSearch(parseSearch("harbor walk"))).toBe(false);
    expect(isRenderSearch(parseSearch("klein", ["klein"]))).toBe(false);
    expect(isRenderSearch(parseSearch("video:"))).toBe(true);
  });

  it("knows what is being typed: a key's name, or its value", () => {
    expect(parseSearch("lo").typing).toEqual({ prefix: "lo" });
    expect(parseSearch("image: lora:da").typing).toEqual({ key: "lora", value: "da" });
    expect(parseSearch("lora:").typing).toEqual({ key: "lora", value: "" });
    expect(parseSearch("lora:da ").typing).toBeNull();
    // a flag has no value to choose, and a whole key's name is not "begun"
    expect(parseSearch("video:").typing).toBeNull();
    expect(parseSearch("model").typing).toBeNull();
    expect(keysFor("s")).toEqual(["sound", "since", "sort"]);
  });

  it("writes a chosen key or value in place of what was being typed", () => {
    expect(completeLast("image: lo", "lora:")).toBe("image: lora:");
    expect(completeLast("lora:da", `lora:${valueText("dasiwa v2")}`)).toBe('lora:"dasiwa v2" ');
    expect(completeLast("video: ", "kept")).toBe("video: kept ");
    expect(completeLast("", "lora:")).toBe("lora:");
    expect(without("video: model:wan kept since:today harbor", parseSearch("video: model:wan kept since:today harbor").tokens[3]!)).toBe("video: model:wan kept harbor");
  });

  it("reads since: as a moment", () => {
    const now = new Date("2026-10-15T12:00:00").getTime();
    expect(sinceOf("3d", now)?.toISOString()).toBe(new Date(now - 3 * 86_400_000).toISOString());
    expect(sinceOf("today", now)?.getHours()).toBe(0);
    expect(sinceOf("2026-10-01", now)?.getDate()).toBe(1);
    expect(sinceOf("soon", now)).toBeNull();
  });
});
