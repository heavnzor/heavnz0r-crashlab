#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { scenarioSchema, type Agent, type Report } from "./schema.js";
import { naiveAgent, replay, resilientAgent, runScenario } from "./runner.js";
import { campaignHTML, writeReport } from "./report.js";
import { serve } from "./mcp.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJSON = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;
const help = `heavnz0r'CrashLab — test the consequences

  crashlab demo --out DIRECTORY
  crashlab run scenario.json --agent naive|resilient|./agent.mjs --out DIRECTORY
  crashlab replay report.json
  crashlab validate scenario.json
  crashlab schema
  crashlab mcp scenario.json [--out DIRECTORY]

Custom agent modules export default async ({ callTool, tools, objective, signal }).
All effects happen in a simulator. run exits 1 on an invariant or runner failure.
`;

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    out: { type: "string" }, agent: { type: "string", default: "resilient" },
    help: { type: "boolean", short: "h" },
  } });
  const [command, path] = positionals;
  const input = () => { if (!path) throw new Error("A JSON input file is required"); return readJSON(path); };
  const output = () => {
    if (!values.out) throw new Error("Pass --out with a new output directory");
    const out = resolve(values.out);
    if (existsSync(out)) throw new Error(`Output already exists: ${out}`);
    return out;
  };
  if (!command || values.help) console.log(help);
  else if (command === "validate") console.log(JSON.stringify({ valid: true, scenario: scenarioSchema.parse(input()).name }));
  else if (command === "schema") {
    const { z } = await import("zod");
    console.log(JSON.stringify(z.toJSONSchema(scenarioSchema), null, 2));
  } else if (command === "mcp") await serve(input(), values.out ? output() : undefined);
  else if (command === "replay") {
    const result = await replay(input() as Report);
    console.log(JSON.stringify({ reproduced: result.reproduced, originalVerdict: result.report.passed ? "PASS" : "FAIL", effects: result.report.effects.length }, null, 2));
    if (!result.reproduced) process.exitCode = 1;
  } else if (command === "run") {
    const out = output();
    const module = values.agent === "naive" ? naiveAgent : values.agent === "resilient" ? resilientAgent :
      (await import(pathToFileURL(resolve(values.agent)).href) as { default: Agent }).default;
    if (typeof module !== "function") throw new Error("Agent module must export a default function");
    const report = await runScenario(input(), module, values.agent);
    writeReport(report, out);
    console.log(`${report.passed ? "PASS" : "FAIL"} · ${report.effects.length} effects · ${report.violations.length} violations\n${join(out, "report.html")}`);
    if (!report.passed) process.exitCode = 1;
  } else if (command === "demo") {
    const out = output();
    mkdirSync(out, { recursive: true });
    const reports: Report[] = [];
    for (const file of readdirSync(join(root, "scenarios")).filter((file) => file.endsWith(".json")).sort()) {
      const scenario = inputScenario(join(root, "scenarios", file));
      for (const [name, agent] of [["naive-retry", naiveAgent], ["idempotent+approval", resilientAgent]] as const) {
        const report = await runScenario(scenario, agent, name);
        reports.push(report);
        writeReport(report, join(out, `run-${reports.length}`));
        console.log(`${report.passed ? "PASS" : "FAIL"}  ${scenario.name.padEnd(28)} ${name.padEnd(20)} effects=${report.effects.length}`);
      }
    }
    writeFileSync(join(out, "index.html"), campaignHTML(reports));
    writeFileSync(join(out, "campaign.json"), JSON.stringify(reports, null, 2) + "\n");
    console.log(`\nOffline fixture campaign · ${join(out, "index.html")}`);
    if (reports.some((report) => report.agent === "idempotent+approval" && !report.passed)) process.exitCode = 1;
  } else throw new Error(`Unknown command: ${command}\n${help}`);
} catch (error) {
  console.error(`CrashLab: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function inputScenario(path: string) { return scenarioSchema.parse(readJSON(path)); }
