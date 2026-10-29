import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createTaskSessionFromClient, type TaskEnabledSession } from "@modelcontextprotocol/ext-tasks/client";

/** The protocol revision MCP Tasks come with. */
export const V2 = "2026-07-28";

/**
 * A client that takes tasks, as a host wires the extension's session: the SDK's client on 2026-07-28 for the discovery, and
 * the extension's own requests posted as they are (its raw dispatch), with the standard headers a 2026-07-28 request carries.
 */
let sent = 0;
export async function tasksClient(url: string, bearer: string): Promise<{ client: Client; session: TaskEnabledSession }> {
  const client = new Client({ name: "zz-test tasks client", version: "1" }, { versionNegotiation: { mode: { pin: V2 } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  const session = createTaskSessionFromClient(client, {
    endpointId: "zz-test-afflatus",
    v2RequestFraming: { protocolVersion: V2, clientInfo: { name: "zz-test tasks client", version: "1" }, clientCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } },
    rawDispatch: async (request) => {
      const r = request as { method: string; params?: { name?: string; taskId?: string } };
      const name = r.params?.name ?? r.params?.taskId;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": V2, "Mcp-Method": r.method, ...(name ? { "Mcp-Name": name } : {}) },
        // the extension hands over the request; its JSON-RPC envelope is the host's
        body: JSON.stringify({ jsonrpc: "2.0", id: ++sent, ...(request as object) }),
      });
      const body = (await res.json()) as { result?: never; error?: never };
      return body.error ? { kind: "error", error: body.error } : { kind: "result", result: body.result! };
    },
  });
  return { client, session };
}
