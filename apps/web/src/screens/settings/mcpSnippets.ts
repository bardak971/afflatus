/**
 * What Settings › Access › Agents (MCP) copies: /mcp's address and Claude Code's command, with the token just made filled
 * in, or a stand-in for one made before (its token was shown once, and is gone).
 */

/** Where a token goes when none was just made. */
export const NO_TOKEN = "<your token>";

/** /mcp's address, from the address the page is open at (the one a client on this network reaches too). */
export const mcpUrl = (origin: string) => `${origin.replace(/\/+$/, "")}/mcp`;

/** Claude Code's command: an HTTP server named afflatus, the token as a header. */
export const claudeCodeCommand = (url: string, token: string | null) => `claude mcp add --transport http afflatus ${url} --header "Authorization: Bearer ${token ?? NO_TOKEN}"`;
