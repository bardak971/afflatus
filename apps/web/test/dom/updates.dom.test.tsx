import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { UpdateFlow, UpdatesView } from "../../src/api";
import { NavRail } from "../../src/NavRail";
import { AboutCard } from "../../src/screens/settings/AboutCard";
import { UpdateNews } from "../../src/UpdateNews";
import { ConfirmHost } from "../../src/Confirm";
import { useBanners } from "../../src/store";
import { useRestarting } from "../../src/updates";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** The server's view of the updates: a bundle on this computer, 0.4.1, nothing newer, checked a moment ago. */
const view = (over: Partial<UpdatesView> = {}): UpdatesView => ({
  version: "0.4.1",
  install: "bundle",
  checks: true,
  checkedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  checkError: null,
  latest: null,
  newer: false,
  here: true,
  canUpdate: false,
  cannot: null,
  flow: null,
  previous: null,
  last: null,
  fallback: null,
  move: null,
  ...over,
});
const release = { version: "0.4.2", tag: "v0.4.2", name: "Afflatus 0.4.2", notes: "- zz-test faster joins", highlights: ["zz-test faster joins"], url: "https://example.test/releases/v0.4.2", publishedAt: null, prerelease: false, security: null };
const out = (over: Partial<UpdatesView> = {}) => view({ latest: release, newer: true, canUpdate: true, ...over });
const flow = (over: Partial<UpdateFlow> = {}): UpdateFlow => ({ phase: "downloading", version: "0.4.2", bytes: 64 * 2 ** 20, total: 128 * 2 ** 20, left: 0, error: null, ...over });

/** The start-up checks as a server that ran them gives them. */
const ranChecks = [{ id: "node", label: "Node", ok: true, detail: "zz-test v24", without: "", fix: "" }];

/** The server answers GET /updates with `v`, and each action with `after` (default: `v`); its start-up checks ran unless said. */
function serve(v: UpdatesView, after: UpdatesView = v, checks: unknown[] = ranChecks) {
  fakeApi.on("GET /updates", v);
  for (const action of ["check", "update", "cancel", "go-back", "move"]) fakeApi.on(`POST /updates/${action}`, after);
  fakeApi.on("GET /health", { ok: true, version: v.version, database: "sqlite", checks, checkedAt: null });
}

/** The row of the last check (Updates), by its label. */
const updatesRow = () => screen.getByText("Updates", { selector: "span" }).closest<HTMLElement>(".grid")!;
const settingsLink = () => screen.getByRole("link", { name: /Settings/ });
const dot = () => settingsLink().querySelector("[data-news]");

describe("the rail's dot on Settings", () => {
  it("shows when a new version is out, its tip naming it", async () => {
    serve(out());
    draw(<NavRail />);
    await waitFor(() => expect(dot()).not.toBeNull());
    expect(settingsLink().getAttribute("data-tip")).toBe("Settings · Afflatus 0.4.2 is out");
  });

  it("is not there when nothing newer is out", async () => {
    serve(view());
    draw(<NavRail />);
    await waitFor(() => expect(fakeApi.calls("GET", "/updates")).toHaveLength(1));
    expect(dot()).toBeNull();
    expect(settingsLink().getAttribute("data-tip")).toBeNull();
  });

  it("goes once About has been seen with that version, and stays gone", async () => {
    serve(out());
    const first = draw(<NavRail />);
    await waitFor(() => expect(dot()).not.toBeNull());
    first.unmount();
    const both = draw(<><NavRail /><AboutCard /></>);
    await screen.findByText("Afflatus 0.4.2 is out");
    await waitFor(() => expect(dot()).toBeNull());
    expect(localStorage.getItem("afflatus.updates.seen")).toBe("0.4.2");
    both.unmount();
    draw(<NavRail />);
    await waitFor(() => expect(fakeApi.calls("GET", "/updates").length).toBeGreaterThan(1));
    expect(dot()).toBeNull();
  });
});

describe("Settings → About's Updates part", () => {
  it("1 · up to date: the check's time, Check now and the switch", async () => {
    serve(view());
    draw(<AboutCard />);
    expect(await screen.findByText("Up to date")).toBeTruthy();
    expect(screen.getByText("checked 20 min ago")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Check for new versions" }).getAttribute("aria-checked")).toBe("true");
    // the Updates row's own, not the start-up checks' of the card below
    within(updatesRow()).getByRole("button", { name: "Check now" }).click();
    await waitFor(() => expect(fakeApi.calls("POST", "/updates/check")).toHaveLength(1));
  });

  it("names its button Check for updates when the start-up checks never ran, so that one Check now shows, theirs", async () => {
    serve(view(), view(), []);
    draw(<AboutCard />);
    expect(await screen.findByText("Not checked yet: the server started before these checks existed.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Check now" })).toHaveLength(1);
    within(updatesRow()).getByRole("button", { name: "Check for updates" }).click();
    await waitFor(() => expect(fakeApi.calls("POST", "/updates/check")).toHaveLength(1));
  });

  it("2 · a new version is out: its notes, and Update sends the update", async () => {
    serve(out(), out({ canUpdate: false, flow: flow({ bytes: 0 }) }));
    const { user } = draw(<AboutCard />);
    expect(await screen.findByText("Afflatus 0.4.2 is out")).toBeTruthy();
    expect(screen.getByText("you have 0.4.1")).toBeTruthy();
    expect(screen.getByText("zz-test faster joins")).toBeTruthy();
    expect(screen.getByRole("link", { name: "All the release notes" }).getAttribute("href")).toBe(release.url);
    expect(screen.getByText("Afflatus restarts; your library stays as it is")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Update to 0.4.2" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/updates/update")).toHaveLength(1));
    // its answer is the update under way
    expect(await screen.findByText("Updating to 0.4.2")).toBeTruthy();
  });

  it("2 · a newer version this bundle cannot take in one click says why, the button off", async () => {
    serve(out({ canUpdate: false, cannot: "This release is not signed: download it by hand." }));
    draw(<AboutCard />);
    expect(await screen.findByText("This release is not signed: download it by hand.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Update to 0.4.2" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("3 · pressed while rendering: waits for the queue, Not now stops it", async () => {
    serve(out({ canUpdate: false, flow: flow({ phase: "waiting", left: 2, bytes: 172 * 2 ** 20, total: 172 * 2 ** 20 }) }), out());
    const { user } = draw(<AboutCard />);
    expect(await screen.findByText("Updating to 0.4.2 once the queue is done")).toBeTruthy();
    expect(screen.getByText(/2 renders left/)).toBeTruthy();
    expect(screen.getByText(/Downloaded and checked/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/updates/cancel")).toHaveLength(1));
  });

  it("4 · updating: the steps, the download's figures, Cancel", async () => {
    serve(out({ canUpdate: false, flow: flow() }));
    draw(<AboutCard />);
    expect(await screen.findByText("Updating to 0.4.2")).toBeTruthy();
    const steps = screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-at"));
    expect(steps.map((li) => li.getAttribute("data-at"))).toEqual(["now", "later", "later", "later"]);
    expect(screen.getByText("64 of 128 MB")).toBeTruthy();
    expect(screen.getByText("Unpacking beside 0.4.1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("5 · updated: Updated today, the previous version kept", async () => {
    serve(view({ version: "0.4.2", previous: { version: "0.4.1", restoresLibrary: true }, last: { kind: "updated", from: "0.4.1", to: "0.4.2", at: new Date().toISOString() } }));
    draw(<AboutCard />);
    expect(await screen.findByText("Updated today")).toBeTruthy();
    expect(screen.getByText("0.4.1, kept")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go back to 0.4.1…" })).toBeTruthy();
  });

  it("6 · did not go through: the reason, and Try again", async () => {
    const error = "The download's signature does not match Afflatus's release key, so it was not used. Nothing was changed: you are on 0.4.1.";
    serve(out({ canUpdate: true, flow: flow({ phase: "failed", error }) }));
    const { user } = draw(<AboutCard />);
    expect(await screen.findByText("The update to 0.4.2 did not go through")).toBeTruthy();
    expect(screen.getByText(error)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/updates/update")).toHaveLength(1));
  });

  it("7 · Docker: the command to copy, no button", async () => {
    serve(out({ install: "docker", canUpdate: false, cannot: "A container cannot replace its own image: pull the new one." }));
    const { user } = draw(<AboutCard />);
    expect(await screen.findByText("docker compose pull && docker compose up -d")).toBeTruthy();
    expect(screen.getByText("The data volume carries your library across.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update to 0.4.2" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("8 · from the sources: the command, and to start again", async () => {
    serve(out({ version: "dev", install: "sources", canUpdate: false, cannot: "Run from the sources: pull and build the new version." }));
    draw(<AboutCard />);
    expect(await screen.findByText("0.4.2 is out on GitHub")).toBeTruthy();
    expect(screen.getByText("git pull && pnpm install && pnpm build")).toBeTruthy();
    expect(screen.getByText("Then start Afflatus again.")).toBeTruthy();
  });

  it("9 · from another computer: the button off, and where to press it; no Check now", async () => {
    serve(out({ here: false, canUpdate: false, cannot: "Only on the computer Afflatus runs on." }));
    draw(<AboutCard />);
    expect(await screen.findByText("only on the computer Afflatus runs on")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Update to 0.4.2" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(updatesRow()).queryByRole("button", { name: "Check now" })).toBeNull();
  });

  it("saves the switch", async () => {
    serve(view());
    fakeApi.on("PUT /settings", {});
    const { user } = draw(<AboutCard />);
    await user.click(await screen.findByRole("switch", { name: "Check for new versions" }));
    await waitFor(() => expect(fakeApi.calls("PUT", "/settings")[0]?.body).toEqual({ afflatusUpdateChecks: false }));
  });
});

describe("Go back", () => {
  it("asks first, with what it undoes, and goes back only on yes", async () => {
    const was = view({ version: "0.4.2", previous: { version: "0.4.1", restoresLibrary: true } });
    serve(was, { ...was, flow: flow({ phase: "restarting", version: "0.4.1" }) });
    fakeApi.on("GET /updates/go-back", { refused: null, billing: ["volume zz-test (50 GB, $3.50/month)"], unknown: false });
    const { user } = draw(<><AboutCard /><ConfirmHost /></>);
    await user.click(await screen.findByRole("button", { name: "Go back to 0.4.1…" }));
    const question = await screen.findByRole("dialog", { name: "Go back to 0.4.1?" });
    expect(question.textContent).toContain("what was made since stays in the folder, not in the list");
    // what keeps billing on RunPod after it, which 0.4.1 has no screen for
    expect(question.textContent).toContain("Still billed on RunPod after it, with no Rented GPUs screen in 0.4.1 to see or remove them: volume zz-test (50 GB, $3.50/month).");
    expect(fakeApi.calls("POST", "/updates/go-back")).toHaveLength(0);
    await user.click(within(question).getByRole("button", { name: /Keep/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Go back to 0.4.1?" })).toBeNull());
    expect(fakeApi.calls("POST", "/updates/go-back")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Go back to 0.4.1…" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Go back to 0.4.1?" })).getByRole("button", { name: "Go back to 0.4.1" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/updates/go-back")).toHaveLength(1));
    // the answer says the server restarts: the page waits for it
    await waitFor(() => expect(useRestarting.getState().from).toBe("0.4.2"));
  });
  it("is refused while a rented GPU runs, said without a question", async () => {
    const was = view({ version: "0.4.2", previous: { version: "0.4.1", restoresLibrary: true } });
    serve(was);
    fakeApi.on("GET /updates/go-back", { refused: "A rented GPU runs: zz-test pod (NVIDIA A40). Stop or terminate it first.", billing: [], unknown: false });
    const { user } = draw(<><AboutCard /><ConfirmHost /></>);
    await user.click(await screen.findByRole("button", { name: "Go back to 0.4.1…" }));
    expect(await screen.findByText(/A rented GPU runs: zz-test pod/)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Go back to 0.4.1?" })).toBeNull();
    expect(fakeApi.calls("POST", "/updates/go-back")).toHaveLength(0);
  });
});

describe("the security banner", () => {
  it("is said once per version: closed, it does not come back", async () => {
    serve(out({ latest: { ...release, security: "zz-test: a pretend hole closed" } }));
    const first = draw(<UpdateNews />);
    await waitFor(() => expect(useBanners.getState().items.map((b) => b.id)).toEqual(["updates:security"]));
    const banner = useBanners.getState().items[0]!;
    expect(banner.title).toBe("Afflatus 0.4.2 fixes a security issue: update when you can");
    expect(banner.text).toBe("zz-test: a pretend hole closed");
    expect(banner.href).toBe("/settings/about");
    useBanners.getState().dismiss("updates:security");
    first.unmount();
    draw(<UpdateNews />);
    await waitFor(() => expect(fakeApi.calls("GET", "/updates").length).toBeGreaterThan(1));
    expect(useBanners.getState().items).toEqual([]);
  });

  it("is not said with the checks off, until Check now is pressed in this page", async () => {
    const off = out({ checks: false, latest: { ...release, security: "zz-test: a pretend hole closed" } });
    serve(off);
    draw(<><NavRail /><UpdateNews /></>);
    await waitFor(() => expect(fakeApi.calls("GET", "/updates").length).toBeGreaterThan(0));
    // the answer read and drawn: a banner or a dot would be there by now
    await new Promise((r) => setTimeout(r, 100));
    expect(useBanners.getState().items).toEqual([]);
    expect(dot()).toBeNull();
    draw(<AboutCard />);
    (await waitFor(() => within(updatesRow()).getByRole("button", { name: "Check now" }))).click();
    await waitFor(() => expect(useBanners.getState().items.map((b) => b.id)).toEqual(["updates:security"]));
  });

  it("is not said for a release that is not a security fix", async () => {
    serve(out());
    draw(<UpdateNews />);
    await waitFor(() => expect(fakeApi.calls("GET", "/updates")).toHaveLength(1));
    expect(useBanners.getState().items).toEqual([]);
  });
});

describe("the 0.3.0 move", () => {
  const offered = () => view({ move: { from: "C:\\zz-test\\afflatus-0.3.0-win-x64\\data", version: "0.3.0", items: 1240, timelines: 1, drafts: 85, bytes: 38.2 * 2 ** 30 } });

  it("offers to bring the library over, and Bring it over sends the move", async () => {
    serve(offered(), { ...offered(), move: null, flow: flow({ phase: "restarting", version: "0.4.1" }) });
    const { user } = draw(<UpdateNews />);
    const dialog = await screen.findByRole("dialog", { name: "Bring your library from Afflatus 0.3.0?" });
    expect(dialog.textContent).toContain("afflatus-0.3.0-win-x64");
    expect(dialog.textContent).toContain("It is moved, not copied");
    expect(within(dialog).getByText("1240 items · 1 timeline · 85 drafts · 38.2 GB")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Bring it over" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/updates/move")).toHaveLength(1));
    expect(await screen.findByRole("alertdialog", { name: "Restarting" })).toBeTruthy();
  });

  it("Start empty leaves it, and it is not asked again in this browser", async () => {
    serve(offered());
    const { user, unmount } = draw(<UpdateNews />);
    await user.click(within(await screen.findByRole("dialog", { name: "Bring your library from Afflatus 0.3.0?" })).getByRole("button", { name: "Start empty" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fakeApi.calls("POST", "/updates/move")).toHaveLength(0);
    unmount();
    draw(<UpdateNews />);
    await waitFor(() => expect(fakeApi.calls("GET", "/updates").length).toBeGreaterThan(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says only the size when the old library's database could not be read", async () => {
    serve(view({ move: { ...offered().move!, items: null, timelines: null, drafts: null, bytes: 340 * 2 ** 20 } }));
    draw(<UpdateNews />);
    const dialog = await screen.findByRole("dialog", { name: "Bring your library from Afflatus 0.3.0?" });
    expect(within(dialog).getByText("340 MB")).toBeTruthy();
  });

  it("is not offered from another computer", async () => {
    serve({ ...offered(), here: false });
    draw(<UpdateNews />);
    await waitFor(() => expect(fakeApi.calls("GET", "/updates")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
