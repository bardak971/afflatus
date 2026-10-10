import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // the server tests run ffmpeg and a pretend ComfyUI: with every file at once (and on CI's smaller runners) a test that
    // takes 2 s alone can take 6; the default 5 s failed three of them now and then. A passing test is no slower for it
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // the tests ask pretend sites on this machine, over plain http, and never the real ones (civitai.ts pretendSites)
    env: { AFFLATUS_PRETEND_SITES: "1" },
  },
});
