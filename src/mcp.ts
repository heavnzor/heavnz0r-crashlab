import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ToolError, World } from "./world.js";
import { writeReport } from "./report.js";

export async function serve(input: unknown, output?: string) {
  const world = new World(input);
  const server = new Server({ name: "heavnz0r-crashlab", version: "0.1.1" }, { capabilities: { tools: {} } });
  // Calls consume the simulation budget and append to its journal, even when
  // the business effect is deduplicated. Persisted snapshots overwrite files.
  const writesReports = output ? true : false;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...world.scenario.tools.map(({ name, description, inputSchema }) => ({
        name, description, inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: writesReports, idempotentHint: false, openWorldHint: false },
      })),
      {
        name: "crashlab_context",
        description: "Return the objective and approval state, recording this call in the simulation journal and consuming its tool-call budget.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: writesReports, idempotentHint: false, openWorldHint: false },
      },
      {
        name: "crashlab_report",
        description: "Finish this simulation and return the effect ledger and invariant verdict. No further context or effect calls are accepted. Repeated reports preserve the same logical state.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args = {} } = request.params;
      if (name === "crashlab_report") {
        world.close();
        const report = world.report("mcp-connected-agent");
        if (output) writeReport(report, output);
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      }
      const result = await world.callTool(name, args);
      if (output) writeReport(world.report("mcp-connected-agent"), output);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      if (output) writeReport(world.report("mcp-connected-agent"), output);
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: error instanceof ToolError ? error.code : "ERROR", message: error instanceof Error ? error.message : String(error) }) }] };
    }
  });
  await server.connect(new StdioServerTransport());
}
