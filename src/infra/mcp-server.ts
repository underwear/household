/** One MCP tool; `call` resolves to its text result. A thrown error goes back to the model as an error result. */
export interface McpTool<Caller> {
  name: string;
  /** Hide and refuse tools unavailable to this authenticated caller. */
  available?(caller: Caller): boolean;
  description: string;
  /** JSON Schema of the arguments; with `additionalProperties: false`, any other argument is refused. */
  inputSchema: { type: "object"; properties?: Record<string, unknown>; additionalProperties?: boolean; required?: string[] };
  call(caller: Caller, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

/** Protocol versions this server speaks; its subset (tools, no streams) is the same in all of them. */
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Id = string | number;
const rpcResult = (id: Id, result: object) => Response.json({ jsonrpc: "2.0", id, result });
const rpcError = (id: Id | null, code: number, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * A minimal MCP server over streamable HTTP: every request is a POST of one JSON-RPC message, answered with
 * plain JSON (no event streams, no sessions). Enough for tools: initialize, tools/list, tools/call, ping.
 * `Caller` is who is asking, as established by the transport in front of it.
 */
export function mcpHandler<Caller>(server: { name: string; version: string }, tools: McpTool<Caller>[]) {
  return async (caller: Caller, request: Request): Promise<Response> => {
    // GET would open a server-to-client stream; clients carry on without one.
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    let message: Record<string, unknown>;
    try {
      message = record(await request.json());
    } catch {
      return rpcError(null, -32700, "parse error");
    }
    const { id, method } = message;
    if (typeof method !== "string") return rpcError(null, -32600, "invalid request");
    // A notification (no id) gets no answer.
    if (typeof id !== "string" && typeof id !== "number") return new Response(null, { status: 202 });
    const params = record(message.params);
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion = typeof asked === "string" && VERSIONS.includes(asked) ? asked : VERSIONS[0];
        return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: server });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: tools.filter(tool => tool.available?.(caller) !== false).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = tools.find((candidate) => candidate.name === params.name && candidate.available?.(caller) !== false);
        if (!tool) return rpcError(id, -32602, `unknown tool ${String(params.name)}`);
        const args = record(params.arguments);
        const known = Object.keys(tool.inputSchema.properties ?? {});
        const extra = tool.inputSchema.additionalProperties === false ? Object.keys(args).filter((name) => !known.includes(name)) : [];
        if (extra.length > 0) {
          const text = `unknown arguments: ${extra.join(", ")} (${tool.name} takes: ${known.join(", ")})`;
          return rpcResult(id, { content: [{ type: "text", text }], isError: true });
        }
        try {
          const text = await tool.call(caller, args, request.signal);
          return rpcResult(id, { content: [{ type: "text", text }] });
        } catch (error) {
          return rpcResult(id, { content: [{ type: "text", text: (error as Error).message }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `method ${method} not found`);
    }
  };
}
