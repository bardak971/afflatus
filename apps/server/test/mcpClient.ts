import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * An MCP client of Afflatus's /mcp over HTTP, the token as a Bearer header, as Claude Code connects. Kept beside the server's
 * tests, where the SDK is a dependency, for the scripts that drive a running Afflatus (scripts/mcp-smoke.ts).
 */
export async function mcpClient(url: string, token: string, name = "mcp-smoke"): Promise<Client> {
  const client = new Client({ name, version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

export type { CallToolResult };
