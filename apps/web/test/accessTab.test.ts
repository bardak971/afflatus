import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { INDEX, settingHref, TABS } from "../src/screens/settings/settingsIndex";

const ROOT = join(import.meta.dirname, "../../..");

/** The files a user or an agent reads words of: the code of the apps and packages, the docs, the root's pages. */
function texts(): string[] {
  const found: string[] = ["README.md", "SECURITY.md", "CONTRIBUTING.md"];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "dist") walk(path);
      } else if (/\.(ts|tsx|md|json)$/.test(e.name)) found.push(path);
    }
  };
  for (const dir of ["apps/server/src", "apps/web/src", "apps/server/test", "apps/web/test", "docs", ...readdirSync(join(ROOT, "packages")).map((p) => `packages/${p}/src`)]) walk(dir);
  return found;
}

describe("Settings › Access", () => {
  it("is a tab of its own, after Interface", () => {
    const ids = TABS.map((t) => t.id as string);
    expect(ids.indexOf("access")).toBe(ids.indexOf("interface") + 1);
  });

  it("holds every Access row, and Interface none", () => {
    const access = INDEX.filter((i) => i.key === "access" || i.key.startsWith("access."));
    expect(access.map((i) => i.label)).toEqual(expect.arrayContaining(["Password", "Agents (MCP)", "Metrics token", "Devices signed in"]));
    for (const i of access) expect(i.tab).toBe("access");
    expect(settingHref("access.mcp")).toBe("/settings/access?find=access.mcp");
  });

  // the card left Interface (0.8.2): a text sending someone to its old place sends them where it is not. The words are
  // put together here so that this file does not hold them; the CHANGELOG keeps its history
  it("is never said to be in Interface again", () => {
    const old = new RegExp(["Interface", "\\s*(›|>|→|&rsaquo;|\\\\u203a)\\s*", "Access"].join(""), "i");
    const said = texts().filter((f) => old.test(readFileSync(join(ROOT, f), "utf8"))).map((f) => relative(ROOT, join(ROOT, f)));
    expect(said).toEqual([]);
  });
});
