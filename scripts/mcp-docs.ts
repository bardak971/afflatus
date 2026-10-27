/**
 * docs/mcp.md's list of tools, written from the tool registry (apps/server/src/mcpTools.ts TOOL_GROUPS), so that the doc
 * cannot drift from what /mcp offers: `pnpm docs:mcp` writes it between the two markers, and `pnpm check:mcp-docs` (and
 * apps/server/test/mcpDocs.test.ts, in the suite) fails when the doc lists another set of tools, or other words, than the
 * registry. Everything outside the markers is written by hand.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TOOL_GROUPS } from "../apps/server/src/mcpTools";
import { SCOPE_WORDS } from "../apps/server/src/mcpTokens";

export const DOC = fileURLToPath(new URL("../docs/mcp.md", import.meta.url));
const START = "<!-- tools:start (written by scripts/mcp-docs.ts from the registry: edit the tools, not this list) -->";
const END = "<!-- tools:end -->";

/** The list as the registry says it: a heading per group, a line per tool with its scope and its description. */
export function toolsSection(): string {
  const count = TOOL_GROUPS.reduce((n, g) => n + g.tools.length, 0);
  const groups = TOOL_GROUPS.map((g) => [
    `### ${g.group}`,
    "",
    ...g.tools.map((t) => `- \`${t.name}\` · ${SCOPE_WORDS[t.scope]}. ${t.description.replace(/\s+/g, " ").trim()}`),
  ].join("\n"));
  return [START, "", `${count} tools in all.`, "", groups.join("\n\n"), "", END].join("\n");
}

/** The doc with its list written anew, or an error when the markers are not there. */
export function withTools(doc: string): string {
  const a = doc.indexOf(START);
  const b = doc.indexOf(END);
  if (a < 0 || b < a) throw new Error(`docs/mcp.md has lost its markers: put back\n${START}\n${END}`);
  return doc.slice(0, a) + toolsSection() + doc.slice(b + END.length);
}

/** The tools the doc's list names, in its order. */
export const namedIn = (doc: string) => [...doc.slice(doc.indexOf(START), doc.indexOf(END)).matchAll(/^- `([a-z_]+)`/gm)].map((m) => m[1]);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // the doc is kept with LF endings whatever the checkout does to it
  const doc = readFileSync(DOC, "utf8").replace(/\r\n/g, "\n");
  const want = withTools(doc);
  if (process.argv.includes("--write")) {
    writeFileSync(DOC, want);
    console.log(`docs/mcp.md: ${namedIn(want).length} tools written.`);
  } else if (want !== doc) {
    const named = new Set(namedIn(doc));
    const missing = TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.name)).filter((n) => !named.has(n));
    console.error(`docs/mcp.md's tools are not the registry's${missing.length ? ` (missing: ${missing.join(", ")})` : " (their words or order changed)"}: run pnpm docs:mcp.`);
    process.exit(1);
  } else {
    console.log(`docs/mcp.md lists the registry's ${namedIn(doc).length} tools.`);
  }
}
