import { canonical, World } from "./world.js";
import type { Agent, Report, Scenario } from "./schema.js";

export async function runScenario(input: unknown, agent: Agent, name = "custom-agent"): Promise<Report> {
  const world = new World(input);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let runnerError: string | undefined;
  try {
    await Promise.race([
      agent({
        callTool: (name, args) => world.callTool(name, args),
        tools: structuredClone(world.scenario.tools), objective: world.scenario.objective, signal: controller.signal,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Agent deadline exceeded")); }, world.scenario.timeoutMs);
      }),
    ]);
  } catch (error) { runnerError = error instanceof Error ? error.message : String(error); }
  finally { if (timer) clearTimeout(timer); world.close(); }
  return world.report(name, runnerError);
}

export async function replay(recorded: Report) {
  if (recorded.schema !== "crashlab.report/v1") throw new Error("Unsupported replay schema");
  const world = new World(recorded.scenario);
  for (const call of recorded.calls) {
    try { await world.callTool(call.tool, call.args); } catch { /* Failed calls are part of the recording. */ }
  }
  world.close();
  const report = world.report(`replay:${recorded.agent}`, recorded.runnerError);
  const same = report.scenarioHash === recorded.scenarioHash &&
    canonical(report.calls) === canonical(recorded.calls) &&
    canonical(report.events) === canonical(recorded.events) &&
    canonical(report.effects) === canonical(recorded.effects) &&
    canonical(report.violations) === canonical(recorded.violations);
  return { reproduced: same, report };
}

function fixtureArguments(tool: Scenario["tools"][number], idempotent: boolean) {
  // These built-in agents are demonstration policies, not general planners.
  return {
    [tool.effect.businessKey]: "release-42",
    title: "Publish the reviewed change",
    ...(idempotent && tool.effect.dedupeKey ? { [tool.effect.dedupeKey]: "release-42:v1" } : {}),
  };
}

export const naiveAgent: Agent = async ({ callTool, tools }) => {
  const tool = tools[0]!;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await callTool(tool.name, fixtureArguments(tool, false)); }
    catch (error) { if ((error as { code?: string }).code !== "TIMEOUT" || attempt === 2) throw error; }
  }
};

export const resilientAgent: Agent = async ({ callTool, tools }) => {
  const context = await callTool("crashlab_context", {}) as { approved: boolean };
  if (!context.approved) return { declined: "Approval required" };
  const tool = tools[0]!;
  const args = fixtureArguments(tool, true);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await callTool(tool.name, args); }
    catch (error) { if ((error as { code?: string }).code !== "TIMEOUT" || attempt === 2) throw error; }
  }
};
