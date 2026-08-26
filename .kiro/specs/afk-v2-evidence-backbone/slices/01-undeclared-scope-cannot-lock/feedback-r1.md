## Evaluator feedback — round 1

VERDICT: REVISE
GAPS: 3
RE_RAISED_GAPS: 0

### If REVISE, specific gaps:
- In scope — "`malformed, missing, empty, placeholder, glob, directory, duplicate-normalized, or otherwise non-concrete scope fails closed`": the matching test collapses glob, directory, duplicate-normalized, and the undefined catch-all "otherwise non-concrete" into one generic "non-concrete" case. It supplies neither concrete inputs nor expected defects for those promised classes, so an implementation can omit one while still satisfying the written test. This violates falsifiability; enumerate the rejected input matrix and observable defect for each class, and define whether "directory" means a trailing separator, an existing repository directory, or something else.
- In scope — "`an invalid declaration ... invokes neither contract evaluator nor generator`": the matching test asserts only that "`evaluator invocation count remains zero`". It never counts or otherwise proves zero generator invocations for an initially invalid declaration. This leaves half of the promised control-flow invariant unverified and violates falsifiability.
- In scope — "`A valid concrete declaration can reach contract evaluation and lock`": the lane test starts with "`Given two accepted contracts`", which assumes the successful negotiation state instead of proving that the new pre-evaluator gate permits a concrete manifest to reach the evaluator and become `LOCKED`. Add a runnable negotiation scenario where a stub planner writes a concrete manifest, the evaluator returns `ACCEPT`, and the assertions observe evaluator invocation and orchestrator-owned `LOCKED` status before lane partitioning.
