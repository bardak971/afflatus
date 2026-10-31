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
        // a migration says what the place was called when it was written: history, as the CHANGELOG
        if (e.name !== "node_modules" && e.name !== "dist" && e.name !== "migrations") walk(path);
        // (a review report is history too, and kept out of the repository: only on the machine it was written on)
      } else if (/\.(ts|tsx|md|json)$/.test(e.name) && !/^code-review-.*\.md$/.test(e.name)) found.push(path);
    }
  };
  for (const dir of ["apps/server/src", "apps/web/src", "apps/server/test", "apps/web/test", "docs", ...readdirSync(join(ROOT, "packages")).map((p) => `packages/${p}/src`)]) walk(dir);
  return found;
}

describe("Settings › Sign-in and Agents (MCP) (card #168: the Access tab, split)", () => {
  it("are tabs of their own, after Notifications", () => {
    const ids = TABS.map((t) => t.id as string);
    expect(ids.indexOf("signin")).toBe(ids.indexOf("notifications") + 1);
    expect(ids.indexOf("agents")).toBe(ids.indexOf("signin") + 1);
    expect(ids).not.toContain("access");
  });

  it("hold every Access row: the password's on Sign-in, the tokens on Agents (MCP)", () => {
    const access = INDEX.filter((i) => i.key === "access" || i.key.startsWith("access."));
    expect(access.map((i) => i.label)).toEqual(expect.arrayContaining(["Password", "Agents (MCP)", "Metrics token", "Devices signed in"]));
    for (const i of access) expect(i.tab).toBe(i.key === "access.mcp" ? "agents" : "signin");
    expect(settingHref("access.mcp")).toBe("/settings/agents?find=access.mcp");
    expect(settingHref("access.password")).toBe("/settings/signin?find=access.password");
  });

  // a text sending someone to a place since gone sends them where it is not. The words are put together here so that this
  // file does not hold them; the CHANGELOG keeps their history
  it("never sends anyone to a Settings place since gone", () => {
    const arrow = "\\s*(›|>|→|&rsaquo;|\\\\u203a)\\s*";
    const gone = [
      ["Interface", "Access"], ["Interface", "Notifications"], ["Settings", "Access(?! Tokens)"], ["Settings", "Designer"], ["Settings", "Command bar"],
      ["ComfyUI", "Electricity"], ["ComfyUI", "First launch"],
    ].map(([a, b]) => new RegExp(`${a}${arrow}${b}`, "i"));
    const said = texts().flatMap((f) => {
      const text = readFileSync(join(ROOT, f), "utf8");
      return gone.filter((re) => re.test(text)).map((re) => `${relative(ROOT, join(ROOT, f))}: ${re.source}`);
    });
    expect(said).toEqual([]);
  });
});
