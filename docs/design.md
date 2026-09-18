# Design / test consequences, not confidence

## Execution model

A scenario supplies tool schemas, a fixed approval context, scheduled faults and invariants. The world validates each call with JSON Schema, then applies an append-only effect. Events and effects have deterministic sequence numbers instead of wall-clock timestamps.

Faults happen before or after the effect boundary. The client cannot distinguish before/after timeout errors. A duplicated request is delivered twice to the same effect handler; a stable idempotency key returns the cached result, while reusing a key for a different payload is a conflict.

The agent sees only its objective, tool catalog and ordinary responses through the SDK adapter. The evaluator can inspect the private ledger. In MCP mode, the final report exposes that ledger and closes the simulation.

## Oracles

Uniqueness and approval are checked against actual effects. Count constraints also run at completion, preventing an agent from scoring a false success by doing nothing. The earliest event violating an invariant is included in the report. Missing completion has no event position and is marked as an end-of-run violation.

These oracles are only as meaningful as the scenario. A business key should identify the user's operation, not a fresh UUID generated on each retry. The scenario must faithfully represent whether the real API supports idempotency.

## AI-first integration

Use a model to propose scenarios from real tool contracts, or connect a live model's tool loop to the simulator. The deterministic engine validates scenarios and evaluates outcomes. No model judge is required to decide whether two records were created.

The included naive/resilient controllers are deliberately small baseline fixtures. Live-model measurements should record provider/model versions, prompts, budgets and repeated runs. Keep hidden fault schedules out of the tested agent's context.

## Replay boundaries

Canonical JSON uses sorted object keys and a scenario SHA-256. Replay compares tool responses, events, effects and violations, including failure outcomes. It replays actions, not model sampling. A changed controller needs a fresh run; a changed real API needs a simulator contract update.

## v0.1 limits

- One in-memory world per process; restart a server to start a new simulation.
- Optional MCP reports persist snapshots after each call; no live process restoration is attempted.
- Append-only effects and fixed approval state; no arbitrary SQL, resource deletion or distributed execution.
- Local custom modules are trusted code. The deadline aborts the adapter and closes future effect calls; it cannot preempt a CPU-bound JavaScript loop or forcibly terminate a third-party model request that ignores its abort signal.
- Report contents can include the supplied tool arguments. Use synthetic or deliberately selected fixture data.

These limits keep the tool small enough to inspect and the counterexamples easy to reproduce.
