import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // the server tests run ffmpeg and a pretend ComfyUI: with every file at once (and on CI's smaller runners) a test that
    // takes 2 s alone can take 6; the default 5 s failed three of them now and then. A passing test is no slower for it
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // the tests ask pretend sites on this machine, over plain http, and never the real ones (civitai.ts pretendSites)
    env: { AFFLATUS_PRETEND_SITES: "1" },
    projects: [
      {
        extends: true,
        test: { name: "node", include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"] },
      },
      // the web's components drawn in a pretend page: happy-dom, lighter than jsdom and quicker to start, and
      // enough for what these tests ask of a page (focus, keys, drops, dialogs). Only these files pay for the page; the
      // other tests stay in node, as fast as they were
      {
        extends: true,
        define: { __AFFLATUS_VERSION__: JSON.stringify("test") },
        test: {
          name: "dom",
          include: ["apps/web/test/dom/**/*.dom.test.tsx"],
          environment: "happy-dom",
          setupFiles: ["apps/web/test/dom/setup.ts"],
        },
      },
    ],
  },
});
