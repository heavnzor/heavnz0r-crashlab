---
name: crashlab
description: Designs and runs bounded agent-tool fault scenarios with CrashLab. Use when testing retries, idempotency, approval handling, or ambiguous tool failures before a workflow change.
---

# CrashLab / break the assumptions

Read the tool catalog and the user's workflow goal. Identify an externally visible effect, its business identity, whether it requires approval, and whether the API supports a stable idempotency key.

Propose a `crashlab.scenario/v1` document with a small append-only simulation. Use only supported faults: `timeout-before`, `timeout-after`, `duplicate-delivery`. Include a completion/count invariant when the action is approved so an agent cannot pass by doing nothing. Put approval and uniqueness requirements in explicit invariants. Validate the document with the CrashLab CLI before running it.

To test a live agent, connect the scenario as an MCP server and give the tested agent only the ordinary tool contract and objective. Keep the fault schedule and expected outcome in the evaluator's context. Ask the tested agent to call `crashlab_report` after completing or declining the operation.

Inspect the actual effect ledger, not just the agent's explanation. A tool timeout does not reveal whether a write happened. Export the report and replay its action sequence. Clearly distinguish replay of recorded actions from a new live-model evaluation. Propose a focused controller/tool correction and rerun the same scenario plus a no-fault control case.
