import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Download, HealthCheck } from "../../src/api";
import { BarHost } from "../../src/bar/BarHost";
import { ContextMenu, useMenu } from "../../src/ContextMenu";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** A button with a right-click menu whose first item is `run`, and the command bar as the app mounts it. */
function Screen({ run }: { run(): void }) {
  const menu = useMenu<string>();
  return (
    <>
      <button type="button" onContextMenu={(e) => menu.open(e, "it")}>Opener</button>
      {menu.menu && <ContextMenu at={menu.menu.at} items={[{ label: "Menu's own", run }, { label: "Another", run }]} label="Actions on it" head={{ title: "It" }} onClose={menu.close} />}
      <BarHost />
    </>
  );
}

describe("the command bar opened over a right-click menu", () => {
  // the bar is a chunk of its own, fetched while the app is idle: here, before the test, as the app has it by then
  beforeAll(() => import("../../src/bar/CommandBar"));

  it("closes the menu and keeps the keys: the arrows move the bar's selection, Enter runs none of the menu's items", async () => {
    const run = vi.fn();
    const { user } = draw(<Screen run={run} />);
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    fireEvent.contextMenu(opener, { button: -1, clientX: 0, clientY: 0 });
    expect(screen.getByRole("menu")).toBeTruthy();

    await user.keyboard("{Control>}k{/Control}");
    const box = await screen.findByRole("combobox", { name: "Search Afflatus" });
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(screen.queryByRole("menu")).toBeNull();

    // the commands are listed without the server (">"): the selection starts on the first and ↓ moves it
    await user.keyboard(">");
    await waitFor(() => expect(box.getAttribute("aria-activedescendant")).toBeTruthy());
    const first = box.getAttribute("aria-activedescendant");
    await user.keyboard("{ArrowDown}");
    expect(box.getAttribute("aria-activedescendant")).not.toBe(first);

    await user.keyboard("{ArrowUp}");
    expect(box.getAttribute("aria-activedescendant")).toBe(first);

    // Enter is the bar's: the command chosen (Render clips…) is written in the box to add its figures; the menu's item does not run
    await user.keyboard("{Enter}");
    expect(run).not.toHaveBeenCalled();
    expect((box as HTMLInputElement).value).toMatch(/^>\s*render clips/i);
  });
});

describe("the command bar on an archived project", () => {
  beforeAll(() => import("../../src/bar/CommandBar"));

  it("unarchives it on Enter, and lists Unarchive first", async () => {
    const project = { kind: "project", id: "zz-test-project", label: "zz-test archived", updatedAt: "2026-10-11T00:00:00.000Z", archived: true, timelines: 0, items: 0, bytes: 0 };
    fakeApi.on("GET /command-index", { entries: [project], inboxItems: 0 });
    fakeApi.on("PATCH /projects/:id", { id: project.id, name: project.label, archivedAt: null });
    const { user } = draw(<BarHost />);
    await user.keyboard("{Control>}k{/Control}");
    const box = await screen.findByRole("combobox", { name: "Search Afflatus" });
    await user.keyboard("zz-test archived");
    await screen.findByRole("option", { name: /zz-test archived/ });
    // the selection on the project's row: its first action is what Enter does
    await waitFor(() => expect(document.getElementById(box.getAttribute("aria-activedescendant") ?? "")?.textContent).toContain("zz-test archived"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fakeApi.calls("PATCH", "/projects/")).toEqual([expect.objectContaining({ path: "/projects/zz-test-project", body: { archived: false } })]));
  });
});

/** The bar opened, `typed` written in it: its box, and the user to go on. */
async function barWith(typed: string) {
  const { user } = draw(<BarHost />);
  await user.keyboard("{Control>}k{/Control}");
  const box = await screen.findByRole("combobox", { name: "Search Afflatus" });
  await user.type(box, typed);
  return { user, box };
}
/** The row the bar's selection is on. */
const selected = (box: HTMLElement) => document.getElementById(box.getAttribute("aria-activedescendant") ?? "")?.textContent ?? "";

const ffmpegFailed: HealthCheck = {
  id: "ffmpeg", label: "ffmpeg", ok: false, detail: "7.1 (PATH) cut 21 frames where 22 were asked (at 24 fps)",
  without: "Trims, exports, joins…", fix: "Get ffmpeg downloads one into Afflatus's data folder.", get: "download",
};
const ffmpegOk: HealthCheck = { ...ffmpegFailed, ok: true, detail: "9.0.2 (PATH)", get: undefined };
const health = (checks: HealthCheck[], here?: boolean) => ({ ok: true, version: "0.6.2", database: "sqlite", checks, checkedAt: null, ...(here === undefined ? {} : { here }) });

describe("ffmpeg in the command bar, as Settings › About has it", () => {
  beforeAll(() => import("../../src/bar/CommandBar"));

  it("gets ffmpeg on Enter when the check fails, from this PC", async () => {
    fakeApi.on("GET /health", health([ffmpegFailed], true));
    fakeApi.on("POST /ffmpeg/get", { phase: "downloading", bytes: 0, total: 1, error: null });
    const { user, box } = await barWith("> get ffmpeg");
    await waitFor(() => expect(selected(box)).toMatch(/Get ffmpeg.*BtbN's GPL build/));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fakeApi.calls("POST", "/ffmpeg/get")).toHaveLength(1));
  });

  it("does not get it from another computer: the row says where to, Enter downloads nothing", async () => {
    fakeApi.on("GET /health", health([ffmpegFailed], false));
    fakeApi.on("POST /ffmpeg/get", { phase: "downloading", bytes: 0, total: 1, error: null });
    const { user, box } = await barWith("> get ffmpeg");
    await waitFor(() => expect(selected(box)).toContain("Get ffmpeg from the PC Afflatus runs on"));
    await user.keyboard("{Enter}");
    // the bar stays open, its footer saying why
    expect(screen.getByRole("combobox", { name: "Search Afflatus" })).toBeTruthy();
    expect(fakeApi.calls("POST", "/ffmpeg/get")).toHaveLength(0);
  });

  it("offers no Get ffmpeg when the check passes, and Check again runs the start-up checks anew", async () => {
    fakeApi.on("GET /health", health([ffmpegOk], true));
    fakeApi.on("POST /health/check", health([ffmpegOk], true));
    const { user, box } = await barWith("> ffmpeg");
    const results = await screen.findByRole("listbox", { name: "Results" });
    await within(results).findByRole("option", { name: /Check this computer again/ });
    expect(within(results).queryByRole("option", { name: /^Get ffmpeg/ })).toBeNull();
    await waitFor(() => expect(selected(box)).toContain("Check this computer again"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fakeApi.calls("POST", "/health/check")).toHaveLength(1));
  });
});

const GB = 2 ** 30;
const dl = (id: string, over: Partial<Download> = {}): Download => ({ id, file: `${id}.safetensors`, folder: "loras", title: id, bytes: 0, total: GB, status: "starting", via: "afflatus", ...over });
const serveDownloads = (items: Download[]) => fakeApi.on("GET /downloads", { on: true, items, manager: { found: false }, via: "afflatus" });

describe("the downloads line and model files in the command bar", () => {
  beforeAll(() => import("../../src/bar/CommandBar"));

  it("removes the waiting downloads, as the line's Remove all waiting", async () => {
    serveDownloads([dl("a", { status: "downloading" }), dl("zz-test-b", { waiting: "behind a" })]);
    fakeApi.on("POST /downloads/cancel-waiting", { cancelled: 1 });
    const { user, box } = await barWith("> remove waiting downloads");
    await waitFor(() => expect(selected(box)).toMatch(/Remove all waiting downloads.*1 file waiting/));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fakeApi.calls("POST", "/downloads/cancel-waiting")).toHaveLength(1));
  });

  it("lists no Remove all waiting downloads among the commands when nothing waits", async () => {
    serveDownloads([dl("a", { status: "downloading" })]);
    await barWith("> waiting downloads");
    const results = await screen.findByRole("listbox", { name: "Results" });
    await waitFor(() => expect(fakeApi.calls("GET", "/downloads")).not.toHaveLength(0));
    expect(within(results).queryByRole("option", { name: /Remove all waiting downloads/ })).toBeNull();
  });

  it("takes a waiting one out of the line in the line's words", async () => {
    serveDownloads([dl("zz-test-b", { waiting: "behind a" })]);
    const { user, box } = await barWith("!zz-test-b");
    await waitFor(() => expect(selected(box)).toContain("zz-test-b"));
    await user.keyboard("{Tab}");
    const actions = await screen.findByRole("listbox", { name: "Actions" });
    expect(within(actions).getByRole("option", { name: /Take it out of the line/ })).toBeTruthy();
    expect(within(actions).queryByRole("option", { name: /Stop this download/ })).toBeNull();
  });

  it("shows a finished download in its folder on this PC, naming the file, never its path", async () => {
    serveDownloads([dl("zz-test-done", { status: "done", bytes: GB, machine: "m1" })]);
    fakeApi.on("GET /model-files/where", { known: true, reveal: true, places: [{ path: "C:\\ComfyUI\\models\\loras\\zz-test-done.safetensors", kind: "own" }] });
    fakeApi.on("POST /model-files/reveal", { ok: true });
    const { user, box } = await barWith("!zz-test-done");
    await waitFor(() => expect(selected(box)).toContain("zz-test-done"));
    await user.keyboard("{Tab}");
    const actions = await screen.findByRole("listbox", { name: "Actions" });
    const show = await within(actions).findByRole("option", { name: /Show in folder/ });
    expect(within(actions).queryByRole("option", { name: /Copy path/ })).toBeNull();
    await user.click(show);
    await waitFor(() => expect(fakeApi.calls("POST", "/model-files/reveal").map((c) => c.body)).toEqual([{ folder: "loras", file: "zz-test-done.safetensors", at: 0, machine: "m1" }]));
  });

  it("shows a LoRA of lora: in its folder, from its value's Tab", async () => {
    fakeApi.on("GET /assets/models", { models: [], loras: [{ file: "zz-test-soft.safetensors", count: 3 }] });
    fakeApi.on("GET /model-files/where", { known: true, reveal: true, places: [{ path: "C:\\ComfyUI\\models\\loras\\zz-test-soft.safetensors", kind: "own" }] });
    fakeApi.on("POST /model-files/reveal", { ok: true });
    const { user, box } = await barWith("lora:zz-test");
    await waitFor(() => expect(selected(box)).toContain("zz-test-soft"));
    await user.keyboard("{Tab}");
    const actions = await screen.findByRole("listbox", { name: "Actions" });
    await user.click(await within(actions).findByRole("option", { name: /Show in folder/ }));
    await waitFor(() => expect(fakeApi.calls("POST", "/model-files/reveal").map((c) => c.body)).toEqual([{ folder: "loras", file: "zz-test-soft.safetensors", at: 0 }]));
  });

  it("offers Copy path, not Show in folder, from another computer", async () => {
    serveDownloads([dl("zz-test-done", { status: "done", bytes: GB })]);
    fakeApi.on("GET /model-files/where", { known: true, reveal: false, places: [{ path: "C:\\ComfyUI\\models\\loras\\zz-test-done.safetensors", kind: "own" }] });
    const { user, box } = await barWith("!zz-test-done");
    await waitFor(() => expect(selected(box)).toContain("zz-test-done"));
    await user.keyboard("{Tab}");
    const actions = await screen.findByRole("listbox", { name: "Actions" });
    await within(actions).findByRole("option", { name: /Copy path/ });
    expect(within(actions).queryByRole("option", { name: /Show in folder/ })).toBeNull();
  });
});
