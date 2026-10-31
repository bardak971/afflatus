import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { budgetVerdict, controlFindings, DESIGN_RULES, designCounts, menuFindings, overBudget, sharedFindings, sources, unmarked, wordFindings } from "../../../scripts/check-shared";

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

  it("refuses a list of the usual model folders outside core's modelFiles.ts, not two folders named together", () => {
    const line = 'export const FOLDERS = ["checkpoints", "diffusion_models", "loras", "vae", "text_encoders"];';
    expect(why("apps/web/src/findModels/store.ts", line)).toEqual(["a list of the usual model folders"]);
    expect(why("apps/server/src/fromLink.ts", "const KNOWN = ['checkpoints', 'diffusion_models', 'unet', 'loras', 'vae', 'text_encoders', 'clip'];")).toEqual(["a list of the usual model folders"]);
    expect(why("packages/core/src/modelFiles.ts", line)).toEqual([]);
    expect(why("apps/web/src/bar/actions/models.tsx", 'export const MODEL_FOLDERS = ["checkpoints", "diffusion_models", "unet"];')).toEqual([]);
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
      "font-size": 1, radius: 1, "z-index": 1, tracking: 1, "raw-colour": 1, "close-icon": 1, "pulse-spin": 0, "icon-button": 1, "bare-error": 0, "animate-motion": 0,
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
  it("counts an error's message shown bare, not one said with what failed, a template's or a tip's (card #177)", () => {
    expect(one("apps/web/src/x.tsx", "{save.isError && <ErrorNote>{save.error.message}</ErrorNote>}<span>{err.message}</span>{access.failed?.message}")["bare-error"]).toBe(3);
    // one of several actions' errors, bracketed
    expect(one("apps/web/src/x.tsx", "<ErrorNote>{(save.error ?? remove.error)?.message}</ErrorNote><span>{(restart.error as Error).message}</span>{(plan.error ?? fill.error)!.message}")["bare-error"]).toBe(3);
    // after a note of its own: the server's words still come bare
    expect(one("apps/web/src/x.tsx", "<ErrorNote>{mic.error ?? send.error?.message}</ErrorNote><span>{pasted ?? add.error?.message}</span>")["bare-error"]).toBe(2);
    expect(one("apps/web/src/x.tsx", '<Failed what="Not saved" error={save.error} /><span data-tip={load.error.message}>{`Not loaded: ${load.error.message}`}</span>')["bare-error"]).toBe(0);
  });
  it("counts a script animation only in a file that never asks motionAllowed", () => {
    expect(one("apps/web/src/x.ts", "el.animate([{ opacity: 0 }], 100); row.animate?.([], 1);")["animate-motion"]).toBe(2);
    expect(one("apps/web/src/x.ts", "if (motionAllowed()) el.animate([{ opacity: 0 }], 100);")["animate-motion"]).toBe(0);
  });
  it("lets through a line marked `design: <why>`, at its end or alone just above it, and that line only", () => {
    const dark = '<div className="bg-black" />';
    expect(one("apps/web/src/x.tsx", `${dark}\n${dark}`)["raw-colour"]).toBe(2);
    // a marker alone on its line speaks for the line below
    expect(one("apps/web/src/x.tsx", `{/* design: the letterbox is black */}\n${dark}\n${dark}`)["raw-colour"]).toBe(1);
    expect(one("apps/web/src/x.tsx", `// design: the letterbox is black\n${dark}`)["raw-colour"]).toBe(0);
    // at the end of a line it covers that line, not the next
    expect(one("apps/web/src/x.ts", "a.animate(f, t); // design: the video's own\nb.animate(f, t);")["animate-motion"]).toBe(1);
    // a marker needs its reason, and an ordinary comment is no marker
    expect(one("apps/web/src/x.tsx", `// design:\n${dark}`)["raw-colour"]).toBe(1);
    expect(one("apps/web/src/x.tsx", `// the letterbox\n${dark}`)["raw-colour"]).toBe(1);
    expect(unmarked("a\n// design: why\nb\nc")).toBe("a\n\n\nc");
    // JSX's block form alone on its line, indented as the UI's files have it, speaks for the line below too
    expect(unmarked(`    {/* design: a live dot */}\n    ${dark}\n    ${dark}`)).toBe(`\n\n    ${dark}`);
    expect(unmarked(`/* design: why */\n${dark}`)).toBe("\n");
  });
  it("lets a marker with code beside it cover its own line only, and takes no marker from a string (review O-19)", () => {
    const dark = '<div className="bg-black" />';
    // a leading marker followed by code is not alone: the next line is counted
    expect(one("apps/web/src/x.tsx", `{/* design: why */} ${dark}\n${dark}`)["raw-colour"]).toBe(1);
    // nor is one with code and then another comment after it: the reason ends at its own comment's close (review O-22)
    expect(one("apps/web/src/x.tsx", `{/* design: why */} ${dark} {/* x */}\n${dark}`)["raw-colour"]).toBe(1);
    expect(one("apps/web/src/x.tsx", `/* design: why */ const a = 1; /* x */\n${dark}`)["raw-colour"]).toBe(1);
    expect(one("apps/web/src/x.tsx", `/* design: */ ${dark} */\n${dark}`)["raw-colour"]).toBe(2);
    // a "//design:" inside a string or a URL is text, not a comment
    expect(one("apps/web/src/x.tsx", `const u = "a//design:b"; ${dark}`)["raw-colour"]).toBe(1);
    expect(one("apps/web/src/x.tsx", `const u = 'https://x//design: b'; ${dark}`)["raw-colour"]).toBe(1);
    // a real comment after a string still marks its line, apostrophes in the reason included
    expect(one("apps/web/src/x.tsx", `const c = "bg-black"; // design: the video's own "black"`)["raw-colour"]).toBe(0);
  });
  it("does not count a menu row's × icon, or the glyph handed to an IconButton, as a close of its own", () => {
    expect(one("apps/web/src/x.tsx", '{ label: "Stop", icon: <X size={14} />, danger: true }')["close-icon"]).toBe(0);
    expect(one("apps/web/src/x.tsx", '<IconButton size={24} label="Take it out" onClick={go}>{off ? <Plus /> : <X size={12} />}</IconButton>')["close-icon"]).toBe(0);
    expect(one("apps/web/src/x.tsx", '<button onClick={close}><X size={14} /></button>')["close-icon"]).toBe(1);
    // only the IconButton's own children: an × of its own after it on the line still counts (review O-19)
    expect(one("apps/web/src/x.tsx", '<IconButton label="a"><X /></IconButton> <button onClick={c}><X size={14} /></button>')["close-icon"]).toBe(1);
    expect(one("apps/web/src/x.tsx", '<IconButton label="a" onClick={() => go()} /> <button onClick={c}><X size={14} /></button>')["close-icon"]).toBe(1);
    expect(one("apps/web/src/x.tsx", '<CloseButton onClose={c} /><X /><X />')["close-icon"]).toBe(2);
    // one that closes further down hands its children the rest of the line
    expect(one("apps/web/src/x.tsx", '<IconButton label="a" onClick={() => go()}>{off ? <Plus /> : <X />}\n</IconButton>')["close-icon"]).toBe(0);
    // the track's 16 px stop in a queued clip's box, by its one shape in its one file
    expect(one("apps/web/src/timeline/track/TrackClip.tsx", "                  <X size={10} />")["close-icon"]).toBe(0);
    expect(one("apps/web/src/timeline/track/Other.tsx", "                  <X size={10} />")["close-icon"]).toBe(1);
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

// rule 11: the menu conventions (apps/web/src/ContextMenu.tsx), where a menu's lines can tell
describe("the menu conventions, read in the source", () => {
  const menu = (...rows: string[]) => ['import type { MenuItem } from "./ContextMenu";', "const items: MenuItem[] = [", ...rows, "];"].join("\n");
  const why = (file: string, text: string) => menuFindings(file, text).map((f) => f.why.replace(/ \(the menu conventions.*$/, ""));
  it("refuses three dots for an ellipsis, a greyed row with no reason, an ellipsis on a submenu's row", () => {
    expect(why("apps/web/src/x.tsx", menu('  { label: "Rename...", run },'))).toEqual(['an ellipsis is one character: "…", not three dots']);
    expect(why("apps/web/src/x.tsx", "<Button>Loading...</Button>")).toEqual(['an ellipsis is one character: "…", not three dots']);
    expect(why("apps/web/src/x.tsx", menu('  { label: "Move up", disabled: i === 0, run },'))).toEqual(["a greyed menu row says why in its note, or is left out as a dead row"]);
    expect(why("apps/web/src/x.tsx", menu('  { label: "Move to…", items: moves },'))).toEqual(["a row that opens a submenu has no ellipsis"]);
  });
  it("takes a reason on the row's next lines, a row that is never off, and files with no menu", () => {
    expect(why("apps/web/src/x.tsx", menu("  {", '    label: "Make it loop", disabled: busy,', '    note: busy ? "making…" : undefined,', "  },"))).toEqual([]);
    expect(why("apps/web/src/x.tsx", menu('  { label: "Delete now…", danger: true, disabled: false, run },'))).toEqual([]);
    // the next row's note is not this one's
    expect(why("apps/web/src/x.tsx", menu('  { label: "A", disabled: true, run },', '  { label: "B", note: "b", run },'))).toEqual(["a greyed menu row says why in its note, or is left out as a dead row"]);
    expect(why("apps/web/src/x.tsx", '<Button disabled={busy} label="Save" />')).toEqual([]);
    expect(why("apps/server/src/x.ts", menu('  { label: "Up", disabled: true },'))).toEqual([]);
  });
  it("finds none in today's web app", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const files = sources(root).map((p) => ({ file: relative(root, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") }));
    expect(files.flatMap(({ file, text }) => menuFindings(file, text))).toEqual([]);
  });
});

// card #54: a word-boundary escape a script turned into the backspace byte, in inspect.ts and in a test. The bytes and
// the backslashes are made by their codes here, so that no tool writing this file can turn one into the other.
describe("the bytes", () => {
  const byte = (code: number) => String.fromCharCode(code);
  const bs = byte(92);

  it("refuses a control character written as a byte, said by its code and shown escaped", () => {
    const found = controlFindings("packages/workflows/src/inspect.ts", `const a = 1;\n  return /previous|prev${byte(8)}|before/i.test(given);`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 2, text: `return /previous|prev${bs}x08|before/i.test(given);` });
    expect(found[0]!.why).toContain("U+0008");
    expect(controlFindings("x.ts", `Buffer.from("PK${byte(3)}${byte(4)}")`)[0]!.why).toContain("U+0003, U+0004");
  });

  it("leaves tabs, line ends and the escapes themselves alone", () => {
    expect(controlFindings("x.ts", `${byte(9)}const re = /prev${bs}b|x${bs}x08/;${byte(13)}${byte(10)}const s = "${bs}x03";${byte(10)}`)).toEqual([]);
  });

  it("reads the tests too, where the other backspace was", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const read = sources(root, { tests: true }).map((p) => relative(root, p).replace(/\\/g, "/"));
    expect(read).toContain("packages/recipes/test/swap.test.ts");
    expect(read).toContain("apps/web/test/dom/copyPicture.dom.test.tsx");
    expect(read).toContain("packages/workflows/src/inspect.ts");
    // and the lint's own reading stays the sources alone
    expect(sources(root).some((p) => /\.test\.tsx?$/.test(p))).toBe(false);
  });
});

