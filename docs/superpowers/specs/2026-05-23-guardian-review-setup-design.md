# Guardian Review Setup + Parallelization

**Status:** approved 2026-05-23
**Author:** Eric Oliveira (with Claude)
**Scope:** AFK pipeline orchestrator + consumer-facing documentation

## Goals

1. Document what a consuming project must put on disk so the post-implementation
   `architect-review` and `pm-review` agents have something to review against.
   Today the contract is implicit — `README.md` mentions the persona files but
   shows no example contents.
2. Ship reference templates for `.claude/agents/architect-review.md` and
   `.claude/agents/pm-review.md` that a consumer can copy in and adapt.
3. Run the two reviews concurrently to halve the post-implementation phase's
   wall-clock time.

## Non-goals

- Not changing how `{{RELEVANT_FILES}}` is sourced. It still comes from the
  PRD's `## Relevant Files` section, parsed by `readRelevantFiles()` in
  `src/prd-reader.ts:8`. Same list for both reviewers.
- Not adding a CLI scaffolding command (e.g. `afk init`). Doc + templates only.
- Not adding pre-flight validation that the consuming project has the
  required files. Could be a follow-up; explicitly out of scope here.
- Not wiring `agents/ceo-review.md` or `agents/evaluator.md` into the
  orchestrator. Those stay vestigial.
- Not relocating the existing `agents/*.md` directory. The new templates
  live at `templates/agents/` alongside it; the existing directory is
  untouched.

## Background

### What the orchestrator actually reads

Only these are loaded by AFK code:

- `<prd-dir>/prd.md` (including its `## Relevant Files` section, stuffed
  into every prompt as `{{RELEVANT_FILES}}`).
- `<prd-dir>/issues.md`.
- `.claude/agents/architect-review.md` and `.claude/agents/pm-review.md` —
  loaded by Claude Code via `claude --agent <name>` at `src/claude.ts:126`.

Everything else (`CONTEXT.md`, `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md`,
`docs/PRODUCT.md`) is read by the *guardian agent itself* at runtime,
because the persona file tells it to. The orchestrator never touches them.

### Current review flow

`src/orchestrator.ts:928-1077`. Sequential:

1. Pre-ship sanity gate (typecheck + lint + tests). If it fails, skip both
   reviews and skip PR creation.
2. Architect review — invoke, wait, parse `review-architect.md` for
   verdict, record on logger.
3. PM review — invoke, wait, parse `review-pm.md` for verdict, record.
4. If both verdicts are SHIP or ACCEPT-WITH-NOTES, commit the review
   files, push, open draft PR.

Both reviews share one worktree (`reviewDir`), reusing an existing checkout
of the feature branch when one exists.

## Design

### Change A — Documentation + templates

**A.1 New section in `README.md`: "Setting up guardian reviews"**

Inserted between the existing "Agent Configuration" section
(`README.md:187-204`) and "Choosing a Backend" (`README.md:206`). The
section:

- States the AFK contract: only `.claude/agents/architect-review.md` and
  `.claude/agents/pm-review.md` are required. `{{RELEVANT_FILES}}` and
  `{{SPECS_DIR}}` are passed in; the persona files decide what else to
  read.
- Names the recommended doc surface — `CONTEXT.md`, `docs/PRODUCT.md`,
  `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md` — described as "the
  layout AFK was designed around" but not enforced. Personas can point
  anywhere.
- Points at `templates/agents/` and shows the copy-and-adapt command.
- Provides a pre-flight checklist (persona files exist; reference your
  docs; declare the read-only contract; include the verdict invariant
  line; `prd.md` has a `## Relevant Files` section).

**A.2 New `templates/agents/architect-review.md`**

Generic version of the existing `agents/architect-review.md`. Strips the
Rumo Fisio specifics (clinic_id, RLS, BUSINESS.md, multi-tenant patterns,
`safeAction`, Phase→Milestone gating) and replaces them with placeholder
references to `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md`, `CONTEXT.md`.

Required content:

- Verdict invariant — must produce a line `**Verdict:** SHIP |
  ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP` in `review-architect.md`. Parsed
  by `artifacts.readReviewVerdict()` at `src/orchestrator.ts:994`.
- Read-only contract — explicit "do not edit source files; only write
  `review-architect.md`." This is what makes shared-worktree
  parallelism safe (Section B.2).
- Severity classification scheme retained from the existing file
  (cosmetic / latent-runtime-risk / blocks-shipping) since it's
  generic and useful.

**A.3 New `templates/agents/pm-review.md`**

Same treatment as A.2, but for PM. Strips Rumo Fisio personas
(owner/secretary/therapist), milestone discipline (M1 vs M2), and
specific PRD references. Replaces with placeholder references to
`docs/PRODUCT.md` and the PRD at `{{SPECS_DIR}}/prd.md`.

Same required content: verdict invariant; read-only contract (do not
edit source; write only `review-pm.md`); severity scheme (cosmetic /
latent-user-impact / blocks-shipping).

**A.4 Existing `agents/` directory**

Untouched. The existing `agents/architect-review.md`,
`agents/pm-review.md`, `agents/ceo-review.md`, etc. remain as vestigial
artifacts of the project AFK was extracted from. Not referenced by
the new docs; not referenced by the orchestrator.

### Change B — Parallel reviews

**B.1 Restructure `src/orchestrator.ts:979-1023`**

Extract two small async functions:

```ts
async function runArchitectReview(...): Promise<ReviewVerdict> {
  const log = logger.agentLog("all", "architect-review");
  try {
    await invoke({
      role: "architect-review",
      agent: "architect-review",
      prompt: renderPrompt("architect-review", { SPECS_DIR, RELEVANT_FILES }),
      cwd: reviewDir,
      logStream: log,
    });
  } finally {
    await new Promise<void>((res) => log.end(() => res()));
  }
  const path = join(reviewDir, specsDir, "review-architect.md");
  return artifacts.readReviewVerdict(path);
}

async function runPmReview(...): Promise<ReviewVerdict> {
  // mirror, with "pm-review" / review-pm.md
}
```

Then run them concurrently:

```ts
const [archSettled, pmSettled] = await Promise.allSettled([
  runArchitectReview(...),
  runPmReview(...),
]);

const archVerdict =
  archSettled.status === "fulfilled" ? archSettled.value : "UNKNOWN";
const pmVerdict =
  pmSettled.status === "fulfilled" ? pmSettled.value : "UNKNOWN";

logger.setReviewVerdicts(archVerdict, pmVerdict);

if (archSettled.status === "rejected") {
  console.warn(`  ⚠️  Architect review failed: ${archSettled.reason}`);
}
if (pmSettled.status === "rejected") {
  console.warn(`  ⚠️  PM review failed: ${pmSettled.reason}`);
}
```

The `UNKNOWN` verdict path is already understood by downstream code: it
gates PR creation off (`shipVerdicts.includes(...)` returns false at
`src/orchestrator.ts:1027-1030`). So a crashed review naturally blocks
the PR — same end behavior as the current sequential flow when parsing
fails.

**B.2 Why this is safe**

Both reviews share `reviewDir`. The persona templates declare a
read-only Mode 3 contract: write only `review-architect.md` /
`review-pm.md`. These output paths are disjoint. Git state is read-only
for both. Two concurrent `claude` child processes is unremarkable — the
per-slice waves at `src/wave.ts` already run multiple `claude`
invocations concurrently.

A consumer who violates the read-only contract by editing source from a
guardian could race in the parallel flow. The sequential flow today
doesn't actually prevent the violation — it only hides it. The
templates make the contract explicit; that's where the safety lives.

**B.3 Behavior change: review failure no longer aborts the pipeline**

The existing test at `src/orchestrator.test.ts:760-833` asserts that a
thrown architect-review propagates as a `PipelineError` from
`runPipeline`. Under `Promise.allSettled`, a thrown invocation becomes
a rejected settlement, surfaces as an `UNKNOWN` verdict, and the
pipeline continues to its normal end (no PR opened, summary written).

This is a deliberate behavior change consistent with the user's intent
("a failure in one shouldn't kill the other"):

- A failed review no longer prevents the surviving review from
  producing a verdict.
- A failed review no longer aborts the whole pipeline. The slices
  already passed; their work is preserved on the feature branch
  regardless. The summary records `UNKNOWN` for the failed reviewer.
- PR creation still gates correctly — `UNKNOWN` is not in
  `shipVerdicts`, so the PR isn't opened.

**Test updates required:**

- Rewrite `src/orchestrator.test.ts:760-833` to assert the new
  contract: a thrown architect-review yields a successful
  `runPipeline` return, with the run summary recording `UNKNOWN` for
  architect, the PM verdict produced normally, and no PR opened.
- Add a parallel test: simulate both reviews throwing; assert both
  `UNKNOWN` and a non-throwing return.
- `src/orchestrator.test.ts:362` is a comment in test setup; no
  change needed.

### Cancellation

Both invocations receive the same `AbortSignal`. A Ctrl-C during reviews
aborts both — same as today.

### Logging

Each review writes to its own log stream via `logger.agentLog("all",
"architect-review")` and `logger.agentLog("all", "pm-review")`. Streams
are independent; no interleaving concerns. Verdicts recorded together
in one `setReviewVerdicts(arch, pm)` call instead of two partial
updates.

## Files touched

| File | Change |
|------|--------|
| `README.md` | Insert "Setting up guardian reviews" section between L204 and L206. |
| `templates/agents/architect-review.md` | New file. |
| `templates/agents/pm-review.md` | New file. |
| `src/orchestrator.ts` | Restructure L979-L1023 to parallelize. |
| `src/orchestrator.test.ts` | Rewrite L760-833 (review-failure test) for new contract; add a both-reviews-fail test. |

## Open questions

None blocking. The follow-up "should AFK pre-flight-validate persona
files exist before starting?" is parked as a future-work item, not part
of this design.

## Acceptance criteria

1. `templates/agents/architect-review.md` and
   `templates/agents/pm-review.md` exist, are generic (no Rumo Fisio
   specifics), declare the verdict invariant, declare the read-only
   contract.
2. README has a "Setting up guardian reviews" section that includes
   the contract, the recommended doc surface, the templates pointer,
   and the pre-flight checklist.
3. The two reviews run concurrently in `runPipeline`. A failure in one
   does not prevent the other from producing a verdict.
4. The review-failure test (orchestrator.test.ts L760-833) is rewritten
   to assert the new contract — `runPipeline` returns successfully, the
   failed reviewer's verdict is `UNKNOWN`, no PR is opened. A new test
   covers both reviewers failing simultaneously.
5. End-to-end: a manual `npx afk-claude` against a small PRD with the
   templates copied in produces both `review-architect.md` and
   `review-pm.md`, and a draft PR opens when both verdicts ship.
