# Ouroboros Harness Mode

NOVA's fixed `ouroboros` harness adopts evidence-loop ideas from
the MIT-licensed [razzant/ouroboros](https://github.com/razzant/ouroboros)
project without embedding a second agent runtime.

It is always enabled. Legacy `minimal`, `adaptive`, and `strict` values are
normalized to Ouroboros during configuration loading. The Tool Router reports
the active harness but does not expose a redundant mode selector.

## Execution contract

For each substantial task the runner instructs the model to:

1. Build a compact task contract containing the objective, outputs,
   constraints, affected workspace, and executable acceptance plan.
2. Work through inspect, plan, act, verify, and accept checkpoints.
3. Change strategy after a failed action instead of repeating an identical
   tool call.
4. Delegate independent substantial branches when useful, then integrate the
   evidence and rerun root-level checks.
5. Run a verifier after the final mutation and inspect the final diff and
   artifacts before claiming completion.
6. Match every literal requirement to final-state evidence or report the exact
   unverified boundary.

The completion gate rejects apparent verifiers that can hide the underlying
exit status, including bare pipelines, `|| true`, and success-forcing echoes.
Pipelines remain valid when failure propagation is explicit, for example with
`set -o pipefail`. The mode permits up to three bounded verifier/correction
passes before failing closed.

## Benchmark scope

This mode is an engineering adaptation, not a reproduced benchmark score.
Ouroboros' published results are model-and-harness results reported by its
authors. Reproduction requires the upstream benchmark adapters, pinned task
sets, clean environments, credentials, deadlines, and official evaluators.
NOVA's repository tests validate its own routing and completion invariants;
they do not substitute for Terminal-Bench, OSWorld, or CL-bench.

For a comparable Terminal-Bench run, follow the upstream
[methodology](https://github.com/razzant/ouroboros/blob/main/devtools/benchmarks/terminal_bench/METHODOLOGY.md)
and retain the task image, model, harness configuration, traces, verifier
output, and cost data with the result.
