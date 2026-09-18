import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("a real MCP client observes ambiguous failure and can inspect the resulting duplicate", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "mcp", fileURLToPath(new URL("../scenarios/01-lost-response.json", import.meta.url))],
    stderr: "pipe",
  });
  const client = new Client({ name: "crashlab-contract-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 3);
    const args = { requestId: "release-42", title: "Publish" };
    const first = await client.callTool({ name: "create_issue", arguments: args });
    assert.equal(first.isError, true);
    assert.equal(JSON.parse(first.content[0].text).code, "TIMEOUT");
    const second = await client.callTool({ name: "create_issue", arguments: args });
    assert.ok(!second.isError);
    const result = await client.callTool({ name: "crashlab_report", arguments: {} });
    const report = JSON.parse(result.content[0].text);
    assert.equal(report.effects.length, 2);
    assert.equal(report.passed, false);
    const after = await client.callTool({ name: "create_issue", arguments: args });
    assert.equal(after.isError, true);
    assert.equal(JSON.parse(after.content[0].text).code, "CLOSED");
  } finally { await client.close(); }
});
