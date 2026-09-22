import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
const REPORT_FILES = ["report.json", "report.html", "junit.xml"];
const scenario = name => JSON.parse(readFileSync(new URL(`../scenarios/${name}.json`, import.meta.url), "utf8"));

async function fixture(t, input, persist = false) {
  const directory = mkdtempSync(join(tmpdir(), "crashlab-mcp-"));
  const path = join(directory, "scenario.json");
  const output = persist ? join(directory, "reports") : undefined;
  writeFileSync(path, JSON.stringify(input));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "mcp", path, ...(output ? ["--out", output] : [])],
    stderr: "pipe",
  });
  const client = new Client({ name: "crashlab-contract-test", version: "1.0.0" });
  t.after(async () => {
    try { await client.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = [...input.tools.map(tool => tool.name), "crashlab_context", "crashlab_report"].sort();
  assert.deepEqual(tools.map(tool => tool.name).sort(), names);
  for (const tool of tools) {
    const expected = tool.name === "crashlab_report" ? [false, true, true, false] : [false, persist, false, false];
    for (const [index, hint] of HINTS.entries()) {
      assert.ok(Object.hasOwn(tool.annotations ?? {}, hint), `${tool.name}.${hint} is absent`);
      assert.equal(typeof tool.annotations[hint], "boolean", `${tool.name}.${hint} must be Boolean`);
      assert.equal(tool.annotations[hint], expected[index]);
    }
  }
  const called = new Set();
  const call = (name, args = {}) => {
    called.add(name);
    return client.callTool({ name, arguments: args });
  };
  return { client, call, called, names, output, directory };
}

function data(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

function error(result, expected) {
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).code, expected);
}

test("all default MCP tools expose hints and reveal a real simulated duplicate", async (t) => {
  const f = await fixture(t, scenario("01-lost-response"));
  const context = data(await f.call("crashlab_context"));
  assert.equal(context.approved, true);
  assert.match(context.objective, /release-42/);
  const args = { requestId: "release-42", title: "Publish" };
  error(await f.call("create_issue", args), "TIMEOUT");
  assert.equal(data(await f.call("create_issue", args)).accepted, true);
  const report = data(await f.call("crashlab_report"));
  assert.equal(report.effects.length, 2);
  assert.equal(report.calls.length, 3);
  assert.equal(report.passed, false);
  assert.equal(report.violations[0].invariant, "unique");
  error(await f.call("create_issue", args), "CLOSED");
  error(await f.call("crashlab_context"), "CLOSED");
  assert.deepEqual([...f.called].sort(), f.names);
});

test("crashlab_context records identical calls and consumes the simulation budget", async (t) => {
  const f = await fixture(t, { ...scenario("05-control"), maxCalls: 2 });
  const first = data(await f.call("crashlab_context"));
  const second = data(await f.call("crashlab_context"));
  assert.deepEqual(first, second);
  error(await f.call("create_issue", { requestId: "release-42", title: "Publish" }), "BUDGET");
  const report = data(await f.call("crashlab_report"));
  assert.deepEqual(report.calls.map(call => call.tool), ["crashlab_context", "crashlab_context"]);
  assert.equal(report.events.length, 2);
  assert.equal(report.effects.length, 0);
  assert.equal(report.passed, false);
});

test("deduplicated MCP effects still append calls, while repeated reports preserve state", async (t) => {
  const f = await fixture(t, scenario("01-lost-response"));
  const args = { requestId: "release-42", title: "Publish", idempotencyKey: "release-42:v1" };
  error(await f.call("create_issue", args), "TIMEOUT");
  const first = data(await f.call("create_issue", args));
  const second = data(await f.call("create_issue", args));
  assert.deepEqual(first, second);
  const report = data(await f.call("crashlab_report"));
  assert.equal(report.effects.length, 1);
  assert.equal(report.calls.length, 3);
  assert.equal(report.events.filter(event => event.kind === "deduplicated").length, 2);
  assert.equal(report.passed, true);
  assert.deepEqual(data(await f.call("crashlab_report")), report);
});

test("persistent MCP calls overwrite reports after success and errors; report retries are stable", async (t) => {
  const f = await fixture(t, scenario("01-lost-response"), true);
  assert.equal(existsSync(f.output), false);
  data(await f.call("crashlab_context"));
  const readReport = () => JSON.parse(readFileSync(join(f.output, "report.json"), "utf8"));
  assert.equal(readReport().calls.length, 1);
  const args = { requestId: "release-42", title: "Publish", idempotencyKey: "release-42:v1" };
  error(await f.call("create_issue", args), "TIMEOUT");
  assert.equal(readReport().effects.length, 1);
  assert.equal(readReport().calls.at(-1).error.code, "TIMEOUT");
  for (const file of REPORT_FILES) writeFileSync(join(f.output, file), "previous snapshot");
  data(await f.call("create_issue", args));
  for (const file of REPORT_FILES) assert.notEqual(readFileSync(join(f.output, file), "utf8"), "previous snapshot");
  const final = data(await f.call("crashlab_report"));
  assert.equal(final.passed, true);
  const before = REPORT_FILES.map(file => readFileSync(join(f.output, file), "utf8"));
  assert.deepEqual(data(await f.call("crashlab_report")), final);
  assert.deepEqual(REPORT_FILES.map(file => readFileSync(join(f.output, file), "utf8")), before);
  assert.deepEqual([...f.called].sort(), f.names);
});

test("scenario-defined MCP tools inherit all hints and each advertised tool is exercised", async (t) => {
  const input = scenario("05-control");
  input.tools.push({
    name: "publish_handoff", description: "Publish a simulated reviewed mission.",
    inputSchema: {
      type: "object", properties: { missionId: { type: "string" }, fingerprint: { type: "string" } },
      required: ["missionId", "fingerprint"], additionalProperties: false,
    },
    effect: { collection: "pullRequests", businessKey: "missionId", dedupeKey: "fingerprint" },
  });
  input.faults = [{ tool: "publish_handoff", at: 1, kind: "duplicate-delivery" }];
  input.invariants.push(
    { kind: "unique", collection: "pullRequests", by: "missionId" },
    { kind: "approval", collection: "pullRequests" },
    { kind: "count", collection: "pullRequests", min: 1, max: 1 },
  );
  const f = await fixture(t, input);
  assert.equal(data(await f.call("crashlab_context")).approved, true);
  data(await f.call("create_issue", { requestId: "release-42", title: "Publish" }));
  const args = { missionId: "r-fixture", fingerprint: "fixture-receipt" };
  const first = data(await f.call("publish_handoff", args));
  assert.equal(first.collection, "pullRequests");
  assert.deepEqual(data(await f.call("publish_handoff", args)), first);
  const report = data(await f.call("crashlab_report"));
  assert.equal(report.passed, true);
  assert.equal(report.effects.length, 2);
  assert.deepEqual([...f.called].sort(), f.names);
});
