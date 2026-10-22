import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { budgetVerdict, DESIGN_RULES, designCounts, overBudget, sharedFindings, sources, wordFindings } from "../../../scripts/check-shared";

// the guard `pnpm lint` runs: what it refuses, and what it leaves alone
describe("the shared helpers' guard", () => {
  const why = (file: string, text: string) => sharedFindings(file, text).map((f) => f.why.split(":")[0]);

  it("refuses a plural made inline", () => {
    expect(why("apps/web/src/x.tsx", "const s = `${n} clip${n === 1 ? \"\" : \"s\"}`;")).toEqual(["a plural made inline"]);
    expect(why("apps/server/src/x.ts", "const s = `file${n !== 1 ? \"s\" : \"\"}`;")).toEqual(["a plural made inline"]);
    expect(why("apps/web/src/x.tsx", "const s = plural(n, \"clip\");")).toEqual([]);
    // The "es" forms too, which slipped past a rule that looked for "s" alone (review S-14).
    expect(why("apps/web/src/x.tsx", "const s = `${n} match${n === 1 ? \"\" : \"es\"}`;")).toEqual(["a plural made inline"]);
    expect(why("apps/web/src/x.tsx", "const s = `switch${n !== 1 ? \"es\" : \"\"}`;")).toEqual(["a plural made inline"]);
    expect(why("apps/web/src/x.tsx", "const s = plural(n, \"match\", \"matches\");")).toEqual([]);
  });

  it("refuses a failure banner made inline, but not in sayFailed.ts", () => {
    const line = "onError: (err) => say({ id: `x:${Date.now()}`, tone: \"bad\", title: \"Could not\", text: err.message }),";
    expect(why("apps/web/src/x.tsx", line)).toEqual(["a failure banner made inline"]);
    expect(why("apps/web/src/sayFailed.ts", line)).toEqual([]);
    expect(why("apps/web/src/x.tsx", "say({ tone: \"bad\", title: \"Nothing to render\" });")).toEqual([]);
  });

  it("refuses a list of model-file extensions outside core's modelFiles.ts", () => {
    const line = "const MODEL_FILE = /\\.(safetensors|ckpt|gguf|sft|pt|pth)$/i;";
    expect(why("packages/core/src/warm.ts", line)).toEqual(["a list of model-file extensions"]);
    expect(why("packages/core/src/modelFiles.ts", line)).toEqual([]);
    // one format's two names, as a VAE's detect pattern has them, is not such a list
    expect(why("packages/recipes/src/flux/index.ts", "detect: [\"(^|[\\\\/])ae\\\\.(safetensors|sft)$\"]")).toEqual([]);
  });

  // An inline plural slipped into check-graphs.ts while the scripts were left out (review O-12).
  it("reads the scripts too, all but its own rules", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const read = sources(root).map((p) => relative(root, p).replace(/\\/g, "/"));
    expect(read).toContain("scripts/check-graphs.ts");
    expect(read).toContain("apps/server/src/index.ts");
    expect(read.some((p) => p.endsWith(".test.ts"))).toBe(false);
    expect(why("scripts/check-graphs.ts", "console.log(`${bad} problem${bad === 1 ? \"\" : \"s\"}`);")).toEqual(["a plural made inline"]);
    expect(why("scripts/check-shared.ts", " *   - a plural made inline (`=== 1 ? \"\" : \"s\"`)")).toEqual([]);
  });
});

// the web app's design held to a budget (review 4, section 4.3): a count may only come down
describe("the design budget", () => {
  const one = (file: string, text: string) => designCounts([{ file, text }]);
  it("counts what the kit or a token does, written by hand in the web app", () => {
    const line = '<button className="h-7 w-7 rounded-[10px] text-[11px] tracking-[0.08em] z-[70] bg-white"><X size={14} /></button>';
    expect(one("apps/web/src/x.tsx", line)).toEqual({
      "font-size": 1, radius: 1, "z-index": 1, tracking: 1, "raw-colour": 1, "close-icon": 1, "pulse-spin": 0, "icon-button": 1, "animate-motion": 0,
    });
    expect(one("apps/web/src/x.tsx", '<span className="animate-spin" /><div className="animate-pulse bg-[#ff0000]" />')).toMatchObject({ "pulse-spin": 2, "raw-colour": 1 });
    // the tokens themselves are not counted
    expect(Object.values(one("apps/web/src/x.tsx", '<IconButton label="Zoom" className="text-meta rounded-control z-popover tracking-label size-8" />')).every((n) => n === 0)).toBe(true);
  });
  it("leaves the kit, the charts and the server alone", () => {
    expect(one("apps/web/src/ui.tsx", '<button className="size-8"><X /></button> animate-spin')).toMatchObject({ "close-icon": 0, "icon-button": 0, "pulse-spin": 0 });
    expect(one("apps/web/src/screens/queue/CostsChart.tsx", 'fill="[#ff8800]"')["raw-colour"]).toBe(0);
    expect(Object.values(one("apps/server/src/x.ts", "text-[11px] z-[9]")).every((n) => n === 0)).toBe(true);
  });
  it("counts a script animation only in a file that never asks motionAllowed", () => {
    expect(one("apps/web/src/x.ts", "el.animate([{ opacity: 0 }], 100); row.animate?.([], 1);")["animate-motion"]).toBe(2);
    expect(one("apps/web/src/x.ts", "if (motionAllowed()) el.animate([{ opacity: 0 }], 100);")["animate-motion"]).toBe(0);
  });
  it("fails a count that went up, and asks to lower a budget a count went under", () => {
    const budget = Object.fromEntries(DESIGN_RULES.map((r) => [r.id, 5]));
    const { up, down } = overBudget({ ...budget, radius: 6, "z-index": 4 }, budget);
    expect(up).toHaveLength(1);
    expect(up[0]).toMatch(/^radius: 6, over its budget of 5/);
    expect(down).toEqual(["z-index: 4, under its budget of 5"]);
    // a rule with no budget yet is held at nothing
    expect(overBudget({ "font-size": 1 }, {}).up).toHaveLength(1);
  });
  it("fails the lint on a count under its budget, saying the number to lower it to, but not on the run that writes it in", () => {
    // A lower count only printed "Lower it" and passed (review O-11), so the budget came down only when someone remembered.
    const budget = Object.fromEntries(DESIGN_RULES.map((r) => [r.id, 5]));
    const under = budgetVerdict({ ...budget, "z-index": 4 }, budget, false);
    expect(under.fails).toBe(true);
    expect(under.lines).toEqual([expect.stringMatching(/z-index: 4, under its budget of 5: lower the budget to 4/)]);
    expect(budgetVerdict({ ...budget, "z-index": 4 }, budget, true)).toEqual({ lines: [], fails: false });
    expect(budgetVerdict(budget, budget, false)).toEqual({ lines: [], fails: false });
    // --budget never raises one: a count over its budget still fails the writing run.
    expect(budgetVerdict({ ...budget, radius: 6 }, budget, true).fails).toBe(true);
  });
  it("holds today's counts: the budget file names every rule, and the sources meet it exactly", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const budget = JSON.parse(readFileSync(`${root}scripts/design-budget.json`, "utf8")) as Record<string, number>;
    expect(Object.keys(budget).sort()).toEqual(DESIGN_RULES.map((r) => r.id).sort());
    const files = sources(root).map((p) => ({ file: relative(root, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") }));
    // The lint's own verdict, so a count under its budget fails here too (review O-15): vitest is on the "done" list and
    // the lint was not, so a budget left high once a count came down passed every check but CI's.
    expect(budgetVerdict(designCounts(files), budget, false)).toEqual({ lines: [], fails: false });
  });
});

// rule 10 (review 4, P4): one word per act, the retired label words refused with the one that replaced them
describe("the retired label words", () => {
  const said = (file: string, text: string) => wordFindings(file, text).map((f) => /say "([^"]+)"/.exec(f.why)![1]);
  it("refuses them in JSX text and in label, aria-label and data-tip strings", () => {
    expect(said("apps/web/src/x.tsx", '<Button onClick={go}>Generate 4 images</Button>')).toEqual(["Render"]);
    expect(said("apps/web/src/x.tsx", '{ label: "Requeue", icon: <RotateCcw size={14} /> },')).toEqual(["Render again"]);
    expect(said("apps/web/src/x.tsx", '{ label: n > 1 ? `Retry all ${n} unchanged` : "Retry unchanged" },')).toEqual(["Render again", "Render again"]);
    expect(said("apps/web/src/x.tsx", '<button aria-label="Cancel this render" />')).toEqual(["Stop"]);
    expect(said("apps/web/src/x.tsx", '<b data-tip="Face detailer: queued at once">')).toEqual(["Face refine"]);
    expect(said("apps/web/src/x.tsx", '<Button aria-label="Delete this picture" />')).toEqual(["Move to bin"]);
    // JSX text on a line of its own, between its tags' lines
    expect(said("apps/web/src/x.tsx", "                  Cancel all waiting…")).toEqual(["Remove all waiting"]);
  });
  it("leaves ids, comments, other words and the server alone", () => {
    expect(said("apps/web/src/x.tsx", '{ id: "generate", label: "Render again" },')).toEqual([]);
    expect(said("apps/web/src/x.tsx", "  // Requeue was its name before")).toEqual([]);
    expect(said("apps/web/src/x.tsx", '<span>{a.origin === "generated" ? "Generated" : "Uploaded"}</span>')).toEqual([]);
    expect(said("apps/server/src/x.ts", 'notes.push("Face detailer");')).toEqual([]);
  });
  it("finds none in today's web app", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const files = sources(root).map((p) => ({ file: relative(root, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") }));
    expect(files.flatMap(({ file, text }) => wordFindings(file, text))).toEqual([]);
  });
});
