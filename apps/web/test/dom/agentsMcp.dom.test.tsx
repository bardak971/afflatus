import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { AgentsBlock } from "../../src/screens/settings/AgentsBlock";
import { claudeCodeCommand, claudeDesktopJson, mcpUrl, NO_TOKEN } from "../../src/screens/settings/mcpSnippets";
import { whereOf } from "../../src/whereReport";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

/**
 * Settings › Access › Agents (MCP), mock v2 (card #23): the address with one Copy, the new-token line, one line per token
 * with its scopes clicked in place and its meters (a scope off greys its meter, never hides it), the token shown once in its
 * row, the row opened on its limits and activity, Revoke asking first, and a change the server holds behind the password.
 */

const NOW = Date.now();
const iso = (ago: number) => new Date(NOW - ago).toISOString();
const token = (over: Record<string, unknown> = {}) => ({
  id: "a".repeat(32), name: "Claude Desktop", scopes: ["look", "make"], rendersPerHour: 30, spendCapCents: 500, tail: "x9Ld",
  createdAt: iso(86_400_000), expiresAt: null, revokedAt: null, lastUsedAt: iso(60_000), lastIp: "127.0.0.1", lastClient: "Claude Desktop",
  state: "live", rendersThisHour: 12, spentThisMonth: 1.2, working: 2, ...over,
});

describe("Agents (MCP)", () => {
  it("with no token: the address, the new-token line, and that /mcp refuses every client", async () => {
    fakeApi.on("GET /mcp/tokens", { tokens: [] });
    draw(<AgentsBlock />);
    expect(await screen.findByText(/No token yet: \/mcp refuses every client until you make one/)).toBeTruthy();
    expect(screen.getByText(`${location.host}/mcp`)).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Make" }).getAttribute("aria-checked")).toBe("true");
  });

  it("makes a token on one line and shows it once, in its row, with its copies", async () => {
    let list: unknown[] = [];
    fakeApi.on("GET /mcp/tokens", () => ({ tokens: list }));
    fakeApi.on("POST /mcp/tokens", ({ body }) => {
      list = [token({ name: (body as { name: string }).name, scopes: ["look"], state: "idle", lastUsedAt: null, createdAt: new Date().toISOString(), rendersThisHour: 0, spentThisMonth: 0, working: 0 })];
      return { token: "afl_mcp_SECRET-shown-once-x9Ld", view: list[0] };
    });
    fakeApi.on("GET /mcp/tokens/:id/activity", { lines: [] });
    const { user } = draw(<AgentsBlock />);
    await screen.findByText(/No token yet/);
    await user.type(screen.getByLabelText("New token's name"), "Cursor");
    await user.click(screen.getByRole("radio", { name: "Look" }));
    await user.click(screen.getByRole("button", { name: "Create token" }));
    expect(fakeApi.calls("POST", "/mcp/tokens")[0]!.body).toEqual({ name: "Cursor", start: "look" });
    expect(await screen.findByText("afl_mcp_SECRET-shown-once-x9Ld")).toBeTruthy();
    expect(screen.getByText("Shown once:")).toBeTruthy();
    expect(screen.getByText(/made just now · never used/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "For Claude Code" })).toBeTruthy();
    // opened at once, on its limits and its (empty) activity
    expect(await screen.findByText("No call yet: kept 30 days.")).toBeTruthy();
    expect((screen.getByLabelText("New token's name") as HTMLInputElement).value).toBe("");
  });

  it("creates a token with no name typed, named after its scopes and the day: the button is never greyed out", async () => {
    fakeApi.on("GET /mcp/tokens", { tokens: [] });
    fakeApi.on("POST /mcp/tokens", ({ body }) => ({ token: "afl_mcp_x", view: token({ name: (body as { name: string }).name }) }));
    fakeApi.on("GET /mcp/tokens/:id/activity", { lines: [] });
    const { user } = draw(<AgentsBlock />);
    await screen.findByText(/No token yet/);
    const create = screen.getByRole("button", { name: "Create token" });
    expect(create.hasAttribute("disabled")).toBe(false);
    await user.click(create);
    expect((fakeApi.calls("POST", "/mcp/tokens")[0]!.body as { name: string }).name).toMatch(/^Make · /);
  });

  it("folds revoked tokens under one line, shown on a click", async () => {
    fakeApi.on("GET /mcp/tokens", { tokens: [token(), token({ id: "c".repeat(32), name: "old pod check", state: "revoked", revokedAt: iso(3_600_000) })] });
    const { user } = draw(<AgentsBlock />);
    await screen.findByRole("button", { name: /^Claude Desktop: open/ });
    expect(screen.queryByRole("button", { name: /^old pod check: open/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "1 revoked token: show" }));
    expect(screen.getByRole("button", { name: /^old pod check: open/ })).toBeTruthy();
  });

  it("draws one line per token: its state, scopes as pills, both meters (a scope off greyed, not hidden), its last use", async () => {
    fakeApi.on("GET /mcp/tokens", { tokens: [token(), token({ id: "b".repeat(32), name: "laptop", scopes: ["look"], state: "idle", expiresAt: iso(-21 * 86_400_000 + 3_600_000), lastUsedAt: iso(26 * 3_600_000), lastIp: "192.168.1.20", working: 0, rendersThisHour: 0, spentThisMonth: 0 })] });
    draw(<AgentsBlock />);
    const row = (await screen.findByRole("button", { name: /^Claude Desktop: open/ })).parentElement!;
    expect(within(row).getByText("connected · 2 jobs in the queue")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Look" }).hasAttribute("disabled")).toBe(true);
    expect(within(row).getByRole("button", { name: "Make" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(row).getByRole("button", { name: "Spend" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(row).getByText("12 / 30")).toBeTruthy();
    expect(within(row).getByRole("meter", { name: "spent this month" })).toBeTruthy();
    expect(within(row).getByText("spent this month").parentElement!.getAttribute("data-tip")).toMatch(/its scope is not ticked/);
    const laptop = screen.getByRole("button", { name: /^laptop: open/ }).parentElement!;
    expect(within(laptop).getByText("ends in 21 days")).toBeTruthy();
    expect(within(laptop).getByText("192.168.1.20")).toBeTruthy();
  });

  it("changes a scope in place, and asks the password when the server holds it behind one", async () => {
    fakeApi.on("GET /mcp/tokens", { tokens: [token()] });
    let tries = 0;
    fakeApi.on("POST /mcp/tokens/:id", ({ body }) => {
      tries++;
      return (body as { current?: string }).current ? { token: token({ scopes: ["look", "make", "spend"] }) } : jsonAnswer({ error: "Type the password to change this.", needPassword: true }, 403);
    });
    const { user } = draw(<AgentsBlock />);
    await user.click(await screen.findByRole("button", { name: "Spend" }));
    expect(await screen.findByText(/This change needs the password/)).toBeTruthy();
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(tries).toBe(2));
    expect(fakeApi.calls("POST", `/mcp/tokens/${"a".repeat(32)}`).map((c) => c.body)).toEqual([
      { scopes: ["look", "make", "spend"] },
      { scopes: ["look", "make", "spend"], current: "correct horse battery" },
    ]);
    await waitFor(() => expect(screen.queryByText(/This change needs the password/)).toBeNull());
  });

  it("opens in place: limits (the spend cap greyed without Spend), the activity in plain words, Only refused, and Revoke asking first", async () => {
    fakeApi.on("GET /mcp/tokens", { tokens: [token()] });
    // the stand-in server matches without the query: which list was asked is read from the request last made
    const refusedAsked = () => fakeApi.calls("GET", "/mcp/tokens/").at(-1)!.path.endsWith("?refused=1");
    fakeApi.on("GET /mcp/tokens/:id/activity", () => ({
      lines: refusedAsked()
        ? [{ id: "2", at: iso(5 * 60_000), tool: "change_setting", said: "the password: never through MCP", refused: true, why: "the password cannot be reached through MCP, whatever the token's scopes: do it in Afflatus itself." }]
        : [
          { id: "1", at: iso(60_000), tool: "whats_open", said: "Asked what is open: Studio › Create › “zz-test café”", refused: false, why: null },
          { id: "2", at: iso(5 * 60_000), tool: "change_setting", said: "the password: never through MCP", refused: true, why: "the password cannot be reached through MCP, whatever the token's scopes: do it in Afflatus itself." },
        ],
    }));
    fakeApi.on("POST /mcp/tokens/:id/revoke", { ok: true });
    const { user } = draw(<AgentsBlock />);
    await user.click(await screen.findByRole("button", { name: /^Claude Desktop: open/ }));
    expect(await screen.findByText(/what is open: Studio › Create › “zz-test café”/)).toBeTruthy();
    expect(screen.getByText("whats_open")).toBeTruthy();
    expect(screen.getAllByText("Refused")).toHaveLength(1);
    expect(screen.getByLabelText("Renders an hour")).toBeTruthy();
    expect(screen.getByLabelText("Spend cap a month").closest("[data-tip]")!.getAttribute("data-tip")).toBe("Spend is not ticked: this token rents nothing");
    await user.click(screen.getByRole("button", { name: "Only refused" }));
    await waitFor(() => expect(screen.queryByText(/what is open/)).toBeNull());
    expect(fakeApi.calls("GET", "/mcp/tokens/").some((c) => c.path.endsWith("?refused=1"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Revoke…" }));
    expect(fakeApi.calls("POST", `/mcp/tokens/${"a".repeat(32)}/revoke`)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(fakeApi.calls("POST", `/mcp/tokens/${"a".repeat(32)}/revoke`)).toHaveLength(1));
  });

  it("copies the address, Claude Code's command and Claude Desktop's block", () => {
    const url = mcpUrl("http://127.0.0.1:8721/");
    expect(url).toBe("http://127.0.0.1:8721/mcp");
    expect(claudeCodeCommand(url, "afl_mcp_x")).toBe('claude mcp add --transport http afflatus http://127.0.0.1:8721/mcp --header "Authorization: Bearer afl_mcp_x"');
    expect(claudeCodeCommand(url, null)).toContain(NO_TOKEN);
    const desktop = JSON.parse(claudeDesktopJson(url, "afl_mcp_x")) as { mcpServers: { afflatus: { command: string; args: string[]; env: Record<string, string> } } };
    expect(desktop.mcpServers.afflatus).toEqual({ command: "npx", args: ["-y", "mcp-remote", url, "--header", "Authorization:${AUTH_HEADER}"], env: { AUTH_HEADER: "Bearer afl_mcp_x" } });
    // plain http from another machine: mcp-remote must be told
    expect(claudeDesktopJson("http://192.168.1.10:8721/mcp", null)).toContain("--allow-http");
  });
});

describe("where the page is (whats_open)", () => {
  it("says the open draft on the Studio only, and the clip selected on its own timeline", () => {
    expect(whereOf("/create", "d1", null)).toEqual({ path: "/create", draft: "d1", timeline: null, clip: null });
    expect(whereOf("/queue", "d1", null)).toEqual({ path: "/queue", draft: null, timeline: null, clip: null });
    expect(whereOf("/timelines/t1", "d1", { timeline: "t1", id: "c2" })).toEqual({ path: "/timelines/t1", draft: null, timeline: "t1", clip: "c2" });
    expect(whereOf("/timelines/t2", null, { timeline: "t1", id: "c2" }).clip).toBeNull();
  });
});
