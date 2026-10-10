import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/** The server's own source files, with their text. */
const SRC = join(import.meta.dirname, "../src");
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
const sources = files(SRC).map((f) => ({ file: relative(SRC, f).split(sep).join("/"), text: readFileSync(f, "utf8") }));

describe("how the server is put together", () => {
  it("reads the environment in one place (config.ts)", () => {
    expect(sources.filter((s) => s.file !== "config.ts" && /process\.env\b/.test(s.text)).map((s) => s.file)).toEqual([]);
  });

  it("keeps the migrations frozen: none imports the app's modules or the recipes, which go on changing", () => {
    const migrations = sources.filter((s) => s.file.startsWith("migrations/") && s.file !== "migrations/index.ts");
    expect(migrations.length).toBeGreaterThan(40);
    const imports = migrations.flatMap((m) => [...m.text.matchAll(/from "([^"]+)"/g)].map((x) => `${m.file}: ${x[1]}`)).filter((line) => !/: (kysely|kysely\/migration|node:[a-z]+|\.\/[\w-]+)$/.test(line));
    expect(imports).toEqual([]);
  });
});
