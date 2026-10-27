import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOC, namedIn, withTools } from "../../../scripts/mcp-docs";
import { TOOLS } from "../src/mcpTools";

// docs/mcp.md's list of tools is written from the registry: a tool added, renamed or reworded without `pnpm docs:mcp` fails here
describe("docs/mcp.md", () => {
  const doc = readFileSync(DOC, "utf8").replace(/\r\n/g, "\n");

  it("names every tool /mcp offers, and no other", () => {
    expect(namedIn(doc)).toEqual(TOOLS.map((t) => t.name));
  });

  it("says each tool in the registry's own words (pnpm docs:mcp writes them)", () => {
    expect(withTools(doc)).toBe(doc);
  });
});
