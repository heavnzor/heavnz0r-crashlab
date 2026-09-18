import { z } from "zod";

const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const tool = z.object({
  name,
  description: z.string().min(1),
  inputSchema: z.object({ type: z.literal("object") }).catchall(z.unknown()),
  effect: z.object({ collection: name, businessKey: name, dedupeKey: name.optional() }).strict(),
}).strict();

const invariant = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unique"), collection: name, by: name }).strict(),
  z.object({ kind: z.literal("approval"), collection: name }).strict(),
  z.object({
    kind: z.literal("count"), collection: name,
    min: z.number().int().nonnegative().default(0),
    max: z.number().int().nonnegative(), whenApproved: z.boolean().default(false),
  }).strict().refine((rule) => rule.min <= rule.max, "Count minimum cannot exceed maximum"),
]);

export const scenarioSchema = z.object({
  schema: z.literal("crashlab.scenario/v1"),
  name: z.string().min(1).max(120),
  objective: z.string().min(5).max(5000),
  approved: z.boolean(),
  maxCalls: z.number().int().min(1).max(100).default(12),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  tools: z.array(tool).min(1).max(20),
  faults: z.array(z.object({
    tool: name, at: z.number().int().min(1).max(100),
    kind: z.enum(["timeout-before", "timeout-after", "duplicate-delivery"]),
  }).strict()).max(100),
  invariants: z.array(invariant).min(1).max(50),
}).strict().superRefine((scenario, ctx) => {
  const names = scenario.tools.map((item) => item.name);
  const collections = new Set(scenario.tools.map((item) => item.effect.collection));
  if (new Set(names).size !== names.length || names.some((item) => item.startsWith("crashlab_"))) {
    ctx.addIssue({ code: "custom", message: "Tool names must be unique and cannot use the reserved crashlab_ prefix" });
  }
  const positions = new Set<string>();
  for (const fault of scenario.faults) {
    const key = `${fault.tool}:${fault.at}`;
    if (!names.includes(fault.tool) || positions.has(key)) {
      ctx.addIssue({ code: "custom", message: "Faults need a declared tool and a unique call position" });
    }
    positions.add(key);
  }
  if (scenario.invariants.some((rule) => !collections.has(rule.collection))) {
    ctx.addIssue({ code: "custom", message: "Invariants must reference a simulated collection" });
  }
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type Effect = {
  id: string; sequence: number; tool: string; collection: string;
  payload: Record<string, unknown>; approved: boolean;
};
export type Event = {
  sequence: number; kind: "call" | "effect" | "fault" | "deduplicated" | "error";
  tool: string; details: unknown;
};
export type Call = {
  tool: string; args: Record<string, unknown>;
  result?: unknown; error?: { code: string; message: string };
};
export type Violation = { invariant: string; message: string; sequence: number | null; effectIds: string[] };
export type Report = {
  schema: "crashlab.report/v1";
  scenarioHash: string;
  scenario: Scenario;
  agent: string;
  passed: boolean;
  calls: Call[];
  events: Event[];
  effects: Effect[];
  violations: Violation[];
  runnerError?: string;
};
export type AgentContext = {
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  tools: Scenario["tools"];
  objective: string;
  signal: AbortSignal;
};
export type Agent = (context: AgentContext) => Promise<unknown>;
