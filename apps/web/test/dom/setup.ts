/**
 * Before every file of the drawn tests (vitest.config.ts, the "dom" project): each test starts on a page as the app
 * opens it, with nothing a test before it left behind (its drawing, the stores it changed, what it kept in the browser),
 * and no request leaves the machine.
 */
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import { resetStores } from "./stores";
import { fakeApi } from "./fakeApi";

// React says when an update is not wrapped in act(): the library's helpers wrap theirs, and the page is told it is a test
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// a part of the app that is a chunk of its own (the command bar, a tile's menu, a question) comes a moment after its
// opening: with the whole suite running at once that moment can pass the library's 1 s, so the tests wait up to 5
configure({ asyncUtilTimeout: 5000 });

// every store the app makes is made through the stand-in (stores.ts), which keeps its first state to go back to
vi.mock("zustand", async () => (await import("./stores")).zustandMock());

beforeEach(() => {
  // a test that wants answers sets them (fakeApi.on); the rest answer 404, so nothing reaches a server
  fakeApi.reset();
  vi.stubGlobal("fetch", fakeApi.fetch);
});

afterEach(() => {
  cleanup();
  resetStores();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // no storage here: nothing was kept
  }
  vi.unstubAllGlobals();
});
