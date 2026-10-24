import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(__dirname, "../src");
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));

describe("the focus ring's offset", () => {
  it("is moved by a class only with the important modifier: styles.css's :focus-visible, outside any layer, beats the utilities", () => {
    // the rule the classes lose to; once it is in a layer, this test and the modifiers can go
    expect(readFileSync(join(src, "styles.css"), "utf8")).toMatch(/^:focus-visible \{[^}]*outline-offset: 2px;/m);
    const dead = files(src).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\bfocus-visible:-?outline-offset-[^\s"'`]+/g)].map((m) => m[0]).filter((c) => !c.endsWith("!")).map((c) => `${relative(src, f)}: ${c}`));
    expect(dead).toEqual([]);
  });
});
