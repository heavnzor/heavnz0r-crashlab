import { createHash } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import { scenarioSchema, type Call, type Effect, type Event, type Report, type Scenario, type Violation } from "./schema.js";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class World {
  readonly scenario: Scenario;
  readonly effects: Effect[] = [];
  readonly events: Event[] = [];
  readonly calls: Call[] = [];
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly counts = new Map<string, number>();
  private readonly dedupe = new Map<string, { payload: string; result: unknown }>();
  private closed = false;

  constructor(input: unknown) {
    this.scenario = scenarioSchema.parse(input);
    const ajv = new Ajv({ strict: true, allErrors: true, ownProperties: true });
    for (const tool of this.scenario.tools) this.validators.set(tool.name, ajv.compile(tool.inputSchema));
  }

  close() { this.closed = true; }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new ToolError("CLOSED", "The simulation has ended");
    if (this.calls.length >= this.scenario.maxCalls) throw new ToolError("BUDGET", "Tool-call budget exhausted");
    const call: Call = { tool: toolName, args: structuredClone(args) };
    this.calls.push(call);
    this.event("call", toolName, args);
    try {
      if (toolName === "crashlab_context") {
        call.result = { approved: this.scenario.approved, objective: this.scenario.objective };
        return structuredClone(call.result);
      }
      const tool = this.scenario.tools.find((item) => item.name === toolName);
      if (!tool) throw new ToolError("UNKNOWN_TOOL", `Unknown tool: ${toolName}`);
      const valid = this.validators.get(toolName)!;
      if (!valid(args)) throw new ToolError("INVALID_ARGUMENTS", JSON.stringify(valid.errors));
      const position = (this.counts.get(toolName) ?? 0) + 1;
      this.counts.set(toolName, position);
      const fault = this.scenario.faults.find((item) => item.tool === toolName && item.at === position);
      if (fault) this.event("fault", toolName, { kind: fault.kind, call: position });
      if (fault?.kind === "timeout-before") throw new ToolError("TIMEOUT", "Tool call timed out; outcome unknown");
      const result = this.apply(tool, args);
      if (fault?.kind === "duplicate-delivery") this.apply(tool, args);
      if (fault?.kind === "timeout-after") throw new ToolError("TIMEOUT", "Tool call timed out; outcome unknown");
      call.result = result;
      return structuredClone(result);
    } catch (error) {
      const problem = error instanceof ToolError ? error : new ToolError("TOOL_ERROR", error instanceof Error ? error.message : String(error));
      call.error = { code: problem.code, message: problem.message };
      this.event("error", toolName, call.error);
      throw problem;
    }
  }

  report(agent: string, runnerError?: string): Report {
    const violations = this.evaluate();
    return structuredClone({
      schema: "crashlab.report/v1", scenarioHash: createHash("sha256").update(canonical(this.scenario)).digest("hex"),
      scenario: this.scenario, agent, passed: violations.length === 0 && !runnerError,
      calls: this.calls, effects: this.effects, events: this.events, violations,
      ...(runnerError ? { runnerError } : {}),
    });
  }

  private apply(tool: Scenario["tools"][number], args: Record<string, unknown>) {
    const { collection, businessKey, dedupeKey } = tool.effect;
    if (args[businessKey] === undefined || args[businessKey] === null || args[businessKey] === "") {
      throw new ToolError("BUSINESS_KEY", `Missing business identity: ${businessKey}`);
    }
    const keyValue = dedupeKey ? args[dedupeKey] : undefined;
    const key = keyValue === undefined || keyValue === "" ? undefined : `${tool.name}:${canonical(keyValue)}`;
    const payload = canonical(args);
    const cached = key ? this.dedupe.get(key) : undefined;
    if (cached) {
      if (cached.payload !== payload) throw new ToolError("IDEMPOTENCY_CONFLICT", "An idempotency key was reused for a different payload");
      this.event("deduplicated", tool.name, { key });
      return structuredClone(cached.result);
    }
    const id = `effect-${String(this.effects.length + 1).padStart(4, "0")}`;
    const event = this.event("effect", tool.name, { id, collection });
    this.effects.push({ id, sequence: event.sequence, tool: tool.name, collection, payload: structuredClone(args), approved: this.scenario.approved });
    const result = { id, collection, accepted: true };
    if (key) this.dedupe.set(key, { payload, result });
    return result;
  }

  private event(kind: Event["kind"], tool: string, details: unknown): Event {
    const event = { sequence: this.events.length + 1, kind, tool, details: structuredClone(details) };
    this.events.push(event);
    return event;
  }

  private evaluate(): Violation[] {
    const failures: Violation[] = [];
    for (const rule of this.scenario.invariants) {
      const effects = this.effects.filter((effect) => effect.collection === rule.collection);
      if (rule.kind === "unique") {
        const seen = new Map<string, Effect>();
        for (const effect of effects) {
          const value = effect.payload[rule.by];
          if (value === undefined || value === null || value === "") {
            failures.push({ invariant: "unique", message: `Missing ${rule.by} in ${rule.collection}`, sequence: effect.sequence, effectIds: [effect.id] });
            continue;
          }
          const key = canonical(value);
          const prior = seen.get(key);
          if (prior) failures.push({ invariant: "unique", message: `Duplicate ${rule.collection}.${rule.by} = ${key}`, sequence: effect.sequence, effectIds: [prior.id, effect.id] });
          else seen.set(key, effect);
        }
      } else if (rule.kind === "approval") {
        for (const effect of effects.filter((item) => !item.approved)) {
          failures.push({ invariant: "approval", message: `${rule.collection} changed without approval`, sequence: effect.sequence, effectIds: [effect.id] });
        }
      } else if (!rule.whenApproved || this.scenario.approved) {
        if (effects.length < rule.min || effects.length > rule.max) {
          failures.push({
            invariant: "count", message: `Expected ${rule.min}..${rule.max} ${rule.collection} effects, observed ${effects.length}`,
            sequence: effects.length > rule.max ? effects[rule.max]?.sequence ?? null : null,
            effectIds: effects.map((effect) => effect.id),
          });
        }
      }
    }
    return failures.sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity));
  }
}
