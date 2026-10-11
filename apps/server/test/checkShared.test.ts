import { describe, expect, it } from "vitest";
import { sharedFindings } from "../../../scripts/check-shared";

// the guard `pnpm lint` runs: what it refuses, and what it leaves alone
describe("the shared helpers' guard", () => {
  const why = (file: string, text: string) => sharedFindings(file, text).map((f) => f.why.split(":")[0]);

  it("refuses a plural made inline", () => {
    expect(why("apps/web/src/x.tsx", "const s = `${n} clip${n === 1 ? \"\" : \"s\"}`;")).toEqual(["a plural made inline"]);
    expect(why("apps/server/src/x.ts", "const s = `file${n !== 1 ? \"s\" : \"\"}`;")).toEqual(["a plural made inline"]);
    expect(why("apps/web/src/x.tsx", "const s = plural(n, \"clip\");")).toEqual([]);
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
});
