import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromEditor, inspect, isEditorFormat } from "../src";
import { corpusFacts } from "./corpusFacts";
import { catalog } from "./fixtures";

/**
 * The importer against real workflows kept locally in ./corpus (see its README): each must map at least
 * as much as expect.json says it did, bind its main parts where it did, and say no more in its notes.
 * "Better" is allowed and printed, so that expect.json can be refreshed. The corpus is not published: what
 * it guards that CI must see too has a hand-made fixture of its own (hostile.test.ts).
 */
const dir = join(import.meta.dirname, "corpus");
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "expect.json").sort() : [];
const expectFile = join(dir, "expect.json");
const expected: Record<string, ReturnType<typeof corpusFacts>> = existsSync(expectFile) ? JSON.parse(readFileSync(expectFile, "utf8")) : {};
const BOOLS = ["result", "prompt", "negative", "model", "startImage", "video", "size", "length"] as const;
const MORE = ["seeds", "toggles", "controls", "stages", "replaced"] as const;

describe.skipIf(!files.length)("the importer on the local corpus", () => {
  it.each(files)("%s maps at least as much as before", (file) => {
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const read = isEditorFormat(raw) ? fromEditor(raw, catalog) : { graph: raw, wiring: undefined, notes: [] as string[] };
    const now = corpusFacts(inspect(read.graph, catalog, read.wiring, read.notes));
    const was = expected[file];
    if (!was) return;
    for (const k of BOOLS) if (was[k]) expect(now[k], k).toBe(true);
    for (const k of MORE) expect(now[k], k).toBeGreaterThanOrEqual(was[k]);
    expect(now.missingNodes, "missingNodes").toBeLessThanOrEqual(was.missingNodes);
    expect(now.notes, "notes").toBeLessThanOrEqual(was.notes);
    for (const [part, target] of Object.entries(was.bound ?? {})) expect(now.bound[part], `bound ${part}`).toBe(target);
    const better = [...BOOLS.filter((k) => !was[k] && now[k]), ...MORE.filter((k) => now[k] > was[k])];
    const fewer = [...(now.missingNodes < was.missingNodes ? ["fewer missing nodes"] : []), ...(now.notes < was.notes ? ["fewer notes"] : [])];
    if (better.length || fewer.length) console.log(`corpus: ${file} maps more than expect.json says (${[...better, ...fewer].join(", ")}): refresh it with pnpm corpus:expect`);
  });
});
