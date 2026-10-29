/**
 * What Settings › Access › Agents (MCP) copies: /mcp's address and Claude Code's command, with the token just made filled
 * in, or a stand-in for one made before (its token was shown once, and is gone); and the line of Claude Code's settings
 * that has it follow MCP Tasks.
 */

/** Where a token goes when none was just made. */
export const NO_TOKEN = "<your token>";

/** /mcp's address, from the address the page is open at (the one a client on this network reaches too). */
export const mcpUrl = (origin: string) => `${origin.replace(/\/+$/, "")}/mcp`;

/** Claude Code's command: an HTTP server named afflatus, the token as a header. */
export const claudeCodeCommand = (url: string, token: string | null) => `claude mcp add --transport http afflatus ${url} --header "Authorization: Bearer ${token ?? NO_TOKEN}"`;

/**
 * The line of `~/.claude/settings.json` that has Claude Code follow MCP Tasks when it runs through the Agent SDK (Sillage,
 * scripts): without it, it declares none, and a long render holds its session (card #154, Claude Code 2.1.312).
 */
export const CLAUDE_TASKS_SETTING = `"env": { "CLAUDE_AUTO_BACKGROUND_TASKS": "1" }`;
