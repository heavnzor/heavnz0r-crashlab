import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { World, runScenario, replay, naiveAgent, resilientAgent, htmlReport, junitReport, scenarioSchema, canonical } from "../dist/index.js";

const load = name => JSON.parse(readFileSync(new URL(`../scenarios/${name}.json`, import.meta.url), "utf8"));
const lost = () => load("01-lost-response");
const args = { requestId: "release-42", title: "Ship the change" };

test("a lost success response creates a reproducible duplicate under naive retry", async () => {
  const report = await runScenario(lost(), naiveAgent, "naive");
  assert.equal(report.passed, false);
  assert.equal(report.effects.length, 2);
  assert.equal(report.calls.length, 2);
  assert.equal(report.calls[0].error.code, "TIMEOUT");
  assert.equal(report.violations[0].invariant, "unique");
  assert.equal(report.violations[0].sequence, report.effects[1].sequence);
  assert.equal((await replay(report)).reproduced, true);
});

test("a stable idempotency key survives response loss with one effect", async () => {
  const report = await runScenario(lost(), resilientAgent, "resilient");
  assert.equal(report.passed, true);
  assert.equal(report.effects.length, 1);
  assert.equal(report.events.filter(event => event.kind === "deduplicated").length, 1);
  assert.equal((await replay(report)).reproduced, true);
});

test("duplicate delivery is observable even when the call returns successfully", async () => {
  const scenario = load("02-duplicate-delivery");
  const bad = await runScenario(scenario, naiveAgent);
  const good = await runScenario(scenario, resilientAgent);
  assert.equal(bad.calls.length, 1);
  assert.equal(bad.calls[0].error, undefined);
  assert.equal(bad.effects.length, 2);
  assert.equal(good.effects.length, 1);
  assert.equal(good.passed, true);
});

test("approval is checked at the effect, not inferred from a successful response", async () => {
  const scenario = load("03-no-approval");
  const bad = await runScenario(scenario, naiveAgent);
  const good = await runScenario(scenario, resilientAgent);
  assert.equal(bad.violations[0].invariant, "approval");
  assert.equal(good.effects.length, 0);
  assert.equal(good.passed, true);
});

test("timeouts before and after effects look identical to the agent", async () => {
  const before = new World(load("04-timeout-before"));
  const after = new World(lost());
  let a, b;
  try { await before.callTool("create_issue", args); } catch (error) { a = error; }
  try { await after.callTool("create_issue", args); } catch (error) { b = error; }
  assert.equal(a.code, b.code);
  assert.equal(a.message, b.message);
  assert.equal(before.effects.length, 0);
  assert.equal(after.effects.length, 1);
});

test("an inactive agent fails the completion invariant instead of gaming the score", async () => {
  const report = await runScenario(lost(), async () => {});
  assert.equal(report.passed, false);
  assert.equal(report.violations[0].invariant, "count");
  assert.equal(report.violations[0].sequence, null);
});

test("payload mutation with a reused idempotency key is rejected", async () => {
  const world = new World(load("05-control"));
  await world.callTool("create_issue", { ...args, idempotencyKey: "same" });
  await assert.rejects(world.callTool("create_issue", { ...args, title: "Different operation", idempotencyKey: "same" }), error => error.code === "IDEMPOTENCY_CONFLICT");
  assert.equal(world.effects.length, 1);
});

test("identical keys with differently ordered object properties deduplicate", async () => {
  const world = new World(load("05-control"));
  const first = await world.callTool("create_issue", { ...args, idempotencyKey: "same" });
  const second = await world.callTool("create_issue", { idempotencyKey: "same", title: args.title, requestId: args.requestId });
  assert.deepEqual(first, second);
  assert.equal(world.effects.length, 1);
});

test("JSON Schema validation rejects malformed arguments before effects", async () => {
  const world = new World(load("05-control"));
  await assert.rejects(world.callTool("create_issue", { requestId: 12, title: "bad" }), error => error.code === "INVALID_ARGUMENTS");
  await assert.rejects(world.callTool("unknown_tool", {}), error => error.code === "UNKNOWN_TOOL");
  assert.equal(world.effects.length, 0);
});

test("faults must target a declared tool and unique invocation", () => {
  const scenario = lost();
  assert.throws(() => scenarioSchema.parse({ ...scenario, faults: [{ tool: "typo", at: 1, kind: "timeout-before" }] }), /declared tool/);
  assert.throws(() => scenarioSchema.parse({ ...scenario, faults: [...scenario.faults, ...scenario.faults] }), /unique call position/);
  assert.throws(() => scenarioSchema.parse({ ...scenario, invariants: [{ kind: "count", collection: "issues", min: 2, max: 1 }] }), /minimum/);
});

test("replay detects altered effects and scenario metadata", async () => {
  const report = await runScenario(lost(), naiveAgent);
  const changed = structuredClone(report);
  changed.effects[0].payload.title = "tampered";
  assert.equal((await replay(changed)).reproduced, false);
  const other = structuredClone(report);
  other.scenario.approved = false;
  assert.equal((await replay(other)).reproduced, false);
});

test("call budget and agent deadline terminate unsuccessful runs", async () => {
  const budget = { ...load("05-control"), maxCalls: 1 };
  const report = await runScenario(budget, resilientAgent);
  assert.equal(report.passed, false);
  assert.match(report.runnerError, /budget/);
  const timeout = await runScenario({ ...lost(), timeoutMs: 100 }, async () => new Promise(() => {}));
  assert.match(timeout.runnerError, /deadline/);
});

test("returned results and reports cannot mutate the simulator ledger", async () => {
  const world = new World(load("05-control"));
  const result = await world.callTool("create_issue", { ...args, idempotencyKey: "stable" });
  result.id = "forged";
  const report = world.report("test");
  report.effects[0].payload.title = "forged";
  assert.equal(world.effects[0].payload.title, args.title);
  const retry = await world.callTool("create_issue", { ...args, idempotencyKey: "stable" });
  assert.equal(retry.id, "effect-0001");
});

test("HTML and JUnit reports escape scenario and model-provided text", async () => {
  const report = await runScenario({ ...lost(), name: '<script>alert("x")</script>' }, naiveAgent);
  const html = htmlReport(report);
  const xml = junitReport(report);
  assert.ok(!html.includes('<script>alert("x")</script>'));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(xml.includes("&lt;script&gt;"));
  assert.match(xml, /failures="2"/);
});

test("all control fixtures pass with the resilient controller", async () => {
  for (const name of ["01-lost-response", "02-duplicate-delivery", "03-no-approval", "04-timeout-before", "05-control"]) {
    assert.equal((await runScenario(load(name), resilientAgent)).passed, true, name);
  }
  assert.equal(canonical({ z: 1, a: 2 }), '{"a":2,"z":1}');
});
