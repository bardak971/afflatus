/**
 * What Settings › Access › Agents (MCP) copies: /mcp's address, Claude Code's command and Claude Desktop's block, with the
 * token just made filled in, or a stand-in for one made before (its token was shown once, and is gone).
 */

/** Where a token goes when none was just made. */
export const NO_TOKEN = "<your token>";

/** /mcp's address, from the address the page is open at (the one a client on this network reaches too). */
export const mcpUrl = (origin: string) => `${origin.replace(/\/+$/, "")}/mcp`;

/** Claude Code's command: an HTTP server named afflatus, the token as a header. */
export const claudeCodeCommand = (url: string, token: string | null) => `claude mcp add --transport http afflatus ${url} --header "Authorization: Bearer ${token ?? NO_TOKEN}"`;

/**
 * Claude Desktop's block of claude_desktop_config.json: it starts servers on its own computer, so a remote one goes through
 * mcp-remote, the header kept in an environment variable (a space in an argument is split on Windows). mcp-remote takes
 * plain http only from this computer unless told.
 */
export function claudeDesktopJson(url: string, token: string | null): string {
  const local = /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?\//i.test(url);
  const args = ["-y", "mcp-remote", url, "--header", "Authorization:${AUTH_HEADER}", ...(/^http:/i.test(url) && !local ? ["--allow-http"] : [])];
  return JSON.stringify({ mcpServers: { afflatus: { command: "npx", args, env: { AUTH_HEADER: `Bearer ${token ?? NO_TOKEN}` } } } }, null, 2);
}
