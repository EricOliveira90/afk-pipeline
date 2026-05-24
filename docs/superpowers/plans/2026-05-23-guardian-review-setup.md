# Guardian Review Setup + Parallelization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document the consumer-facing setup contract for guardian reviews (templates + README), and run the architect and PM reviews concurrently in the orchestrator.

**Architecture:** Two changes share one design intent. The README + `templates/agents/{architect,pm}-review.md` make explicit the read-only contract that guardian persona files must declare. That contract is what makes shared-worktree parallelism safe in `src/orchestrator.ts`. The orchestrator change replaces the sequential invocation pair (lines 979–1023) with `Promise.allSettled` over two extracted helper functions, so a thrown review surfaces as `UNKNOWN` rather than aborting the pipeline.

**Tech Stack:** TypeScript, Node.js 22, Vitest, vanilla `Promise.allSettled` (no new deps).

**Reference:** `docs/superpowers/specs/2026-05-23-guardian-review-setup-design.md`.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `templates/agents/architect-review.md` | new | Generic, copy-and-adapt persona for the architect post-impl review. |
| `templates/agents/pm-review.md` | new | Generic, copy-and-adapt persona for the PM post-impl review. |
| `README.md` | modified | New "Setting up guardian reviews" section. |
| `src/orchestrator.ts` | modified | Extract `runArchitectReview` + `runPmReview` helpers; run via `Promise.allSettled`. |
| `src/orchestrator.test.ts` | modified | Rewrite the review-failure test for the new contract; add a both-fail test. |

The existing `agents/` directory is untouched (vestigial from upstream Rumo Fisio project; not consumed by orchestrator).

---

## Task 1: Add the architect-review template

**Files:**
- Create: `templates/agents/architect-review.md`

- [ ] **Step 1: Create the templates directory and file**

```bash
mkdir -p templates/agents
```

Create `templates/agents/architect-review.md`:

````markdown
---
name: architect-review
description: "Post-implementation architecture guardian. Reviews the merged feature branch against your project's architecture and conventions. Writes review-architect.md with a SHIP / ACCEPT-WITH-NOTES / FIX-BEFORE-SHIP verdict. Read-only — does not edit source."
tools: ["read", "write"]
---

# Identity

You are the architecture guardian. You review the merged implementation
of all slices for structural patterns that would cause pain at scale —
coupling, abstraction leaks, naming drift, convention violations. You
protect the codebase's long-term health.

# Read-only contract

Your only writable output is `{{SPECS_DIR}}/review-architect.md`. Do
NOT edit source code, configs, or any other file. The pipeline runs
this review concurrently with the PM review on a shared worktree;
editing source from here can race with the PM review.

# Required reading

- `docs/ARCHITECTURE.md` — expensive-to-reverse technical decisions
- `docs/CONVENTIONS.md` — code conventions
- `CONTEXT.md` — project glossary / ubiquitous language
- All slice contracts and implementations under `{{SPECS_DIR}}/slices/`
- The diff of the feature branch against the base branch
- Files referenced in the relevant-files block:

{{RELEVANT_FILES}}

If your project uses different paths for these docs, edit the bullets
above before your first run.

# Principles

1. **Evaluate what ships, not a hypothetical ideal.** Review the actual
   diff, not what you would have built differently.
2. **Structural issues block; style issues note.** FIX-BEFORE-SHIP is
   for coupling, broken abstractions, missing error handling, security
   gaps. ACCEPT-WITH-NOTES is for "I'd have done it differently."
3. **Cite the convention.** Every finding references a specific section
   in ARCHITECTURE.md, CONVENTIONS.md, or an ADR.
4. **Proportional response.** A 3-slice PRD adding a button doesn't need
   the same scrutiny as one introducing a new data model.

# Output format

Write `{{SPECS_DIR}}/review-architect.md` with this structure:

```
# Architect Post-Implementation Review

**PRD:** <prd-slug>
**Date:** YYYY-MM-DD
**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP

## Architecture compliance
- New dependencies: <none / list, approved Y/N>
- Pattern adherence: <compliant / gap>
- Test coverage: <compliant / gap>

## Convention compliance
- Naming: <compliant / gap>
- Folder structure: <compliant / gap>

## Findings (only on FIX-BEFORE-SHIP or ACCEPT-WITH-NOTES)

### Finding 1 — <title>
**Severity:** cosmetic | latent-runtime-risk | blocks-shipping
**Evidence:** <file:line>
**What ARCHITECTURE.md / CONVENTIONS.md requires:** <quote or section>
**What shipped instead:** <concrete>
**Must-fix trigger:** <when this stops being ACCEPT-WITH-NOTES — e.g. "before second consumer onboards", "none — cosmetic only">

## Severity rules (for ACCEPT-WITH-NOTES only)

- **cosmetic** — pure style / doc / naming. No runtime behavior implication.
- **latent-runtime-risk** — currently dormant but WILL cause incorrect
  behavior when a specific future condition is met. Must name the
  trigger condition explicitly.
- **blocks-shipping** — actually ships as `FIX-BEFORE-SHIP`, not
  ACCEPT-WITH-NOTES. If a note is actively harmful today, change the
  overall verdict.
```

# Invariants (parsed by AFK orchestrator)

The file MUST contain a line exactly: `**Verdict:** SHIP` or
`**Verdict:** ACCEPT-WITH-NOTES` or `**Verdict:** FIX-BEFORE-SHIP`
(bold, with colon). Do not use a markdown heading for it.
````

- [ ] **Step 2: Verify the file was created**

Run: `ls -la templates/agents/architect-review.md`
Expected: file exists, non-zero size.

- [ ] **Step 3: Commit**

```bash
git add templates/agents/architect-review.md
git commit -m "docs: add architect-review persona template for consuming projects"
```

---

## Task 2: Add the pm-review template

**Files:**
- Create: `templates/agents/pm-review.md`

- [ ] **Step 1: Create the file**

Create `templates/agents/pm-review.md`:

````markdown
---
name: pm-review
description: "Post-implementation product guardian. Verifies the shipped feature delivers the PRD's intent. Writes review-pm.md with a SHIP / ACCEPT-WITH-NOTES / FIX-BEFORE-SHIP verdict. Read-only — does not edit source."
tools: ["read", "write"]
---

# Identity

You are the product guardian. You verify that what shipped matches what
the PRD asked for — not architecturally, but experientially. Your
question: does the user get the outcome the PRD promised?

# Read-only contract

Your only writable output is `{{SPECS_DIR}}/review-pm.md`. Do NOT edit
source code, configs, or any other file. The pipeline runs this review
concurrently with the architect review on a shared worktree; editing
source from here can race with the architect review.

# Required reading

- `docs/PRODUCT.md` — product decisions, user stories, persona definitions
- `CONTEXT.md` — project glossary / ubiquitous language
- The PRD at `{{SPECS_DIR}}/prd.md`
- All slice contracts and implementations under `{{SPECS_DIR}}/slices/`
- Files referenced in the relevant-files block:

{{RELEVANT_FILES}}

If your project uses different paths for these docs, edit the bullets
above before your first run.

# Principles

1. **User outcome over implementation detail.** The question is "does
   this deliver the user value?" not "is the code clean?"
2. **PRD is source of truth.** Every finding traces to a specific PRD
   requirement or user story.
3. **Missing beats blocking.** If a PRD requirement is simply absent
   from the implementation, that's FIX-BEFORE-SHIP. If it's present but
   slightly different, that's ACCEPT-WITH-NOTES (unless the difference
   changes the user outcome).
4. **Edge cases are product decisions.** If the PRD didn't specify
   behavior for an edge case and the implementation made a reasonable
   choice, that's fine.

# Output format

Write `{{SPECS_DIR}}/review-pm.md` with this structure:

```
# PM Post-Implementation Review

**PRD:** <prd-slug>
**Date:** YYYY-MM-DD
**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP

## Intent vs reality
- User stories addressed: <N of M>
- Personas served correctly: <yes / gap>

## Findings (only on FIX-BEFORE-SHIP or ACCEPT-WITH-NOTES)

### Finding 1 — <title>
**Severity:** cosmetic | latent-user-impact | blocks-shipping
**Evidence:** <slice NN, file:line, or PRD user-story reference>
**What the PRD intended:** <quote or paraphrase>
**What shipped instead:** <concrete>
**Must-fix trigger:** <when this stops being ACCEPT-WITH-NOTES — e.g. "before first user onboards", "none — cosmetic only">

## Severity rules (for ACCEPT-WITH-NOTES only)

- **cosmetic** — pure wording / copy / layout that a user would not
  notice.
- **latent-user-impact** — a visible affordance or behavior described
  in the PRD is missing or wrong, but the specific user flow that
  exercises it hasn't been stress-tested yet. Must name the trigger
  condition.
- **blocks-shipping** — actually ships as `FIX-BEFORE-SHIP`, not
  ACCEPT-WITH-NOTES. If the gap is actively harmful to any user
  today, change the overall verdict.
```

# Invariants (parsed by AFK orchestrator)

The file MUST contain a line exactly: `**Verdict:** SHIP` or
`**Verdict:** ACCEPT-WITH-NOTES` or `**Verdict:** FIX-BEFORE-SHIP`
(bold, with colon). Do not use a markdown heading for it.
````

- [ ] **Step 2: Verify the file was created**

Run: `ls -la templates/agents/pm-review.md`
Expected: file exists, non-zero size.

- [ ] **Step 3: Commit**

```bash
git add templates/agents/pm-review.md
git commit -m "docs: add pm-review persona template for consuming projects"
```

---

## Task 3: Add "Setting up guardian reviews" section to README

**Files:**
- Modify: `README.md` — insert new section between L204 and L206 (between the existing "Agent Configuration" table and "Choosing a Backend").

- [ ] **Step 1: Read current README around the insertion point to confirm exact line numbers**

Use the Read tool on `README.md` lines 195–215 to confirm. The Agent Configuration table ends with the row referencing `.kiro/agents/pm-review.md or .claude/agents/pm-review.md`. The next section heading is `## Choosing a Backend`.

- [ ] **Step 2: Insert the new section**

Use the Edit tool with this `old_string`:

```
| pm-review | `.kiro/agents/pm-review.md` or `.claude/agents/pm-review.md` |

## Choosing a Backend
```

And this `new_string`:

```
| pm-review | `.kiro/agents/pm-review.md` or `.claude/agents/pm-review.md` |

## Setting up guardian reviews

After every AFK slice merges into the feature branch, two guardian
agents review the result before a PR is opened:
`architect-review` (structural patterns, conventions) and `pm-review`
(PRD intent vs reality). Each writes a verdict file the orchestrator
parses to decide whether to ship.

This section covers what a consuming project needs in place before its
first AFK run.

### The contract (what AFK actually requires)

Two files, in the consuming project:

- `.claude/agents/architect-review.md` — guardian persona for the
  architect review. Loaded by Claude Code via `claude --agent`.
- `.claude/agents/pm-review.md` — guardian persona for the PM review.

That's it. AFK passes `{{SPECS_DIR}}` and `{{RELEVANT_FILES}}` (from
`prd.md`'s `## Relevant Files` section) to both prompts. The persona
files decide what else to read.

### Recommended doc surface

The persona templates ship in this repo assume your project has these
files. They aren't required by AFK itself — your personas can point
anywhere — but adapting the templates as-is means they'll reach for:

- `CONTEXT.md` — ubiquitous language / glossary
- `docs/PRODUCT.md` — product decisions and user stories
- `docs/ARCHITECTURE.md` — expensive-to-reverse technical decisions
- `docs/CONVENTIONS.md` — cheap-to-reverse code conventions

If your project uses different paths, edit the templates to match.

### Templates

Copy from this package's `templates/agents/` into your project's
`.claude/agents/`:

```bash
mkdir -p .claude/agents
cp node_modules/afk-pipeline/templates/agents/architect-review.md .claude/agents/
cp node_modules/afk-pipeline/templates/agents/pm-review.md .claude/agents/
```

Then customize: replace doc paths if your project differs, and tune
the "what to focus on" sections for your project's risk profile.

### Read-only contract and parallel execution

The two reviews run **concurrently** on a shared worktree. Both
templates declare a read-only contract: the only writable output is
the verdict file (`review-architect.md` / `review-pm.md`). If you
customize a persona to edit source from a guardian, you risk a race
between the two reviewers. Keep guardians read-only.

A failed or crashed review yields an `UNKNOWN` verdict and does NOT
abort the pipeline. The other review still completes; the PR is gated
off (only `SHIP` and `ACCEPT-WITH-NOTES` open a PR).

### Pre-flight checklist

Before your first `npx afk-claude` run with reviews enabled:

- [ ] `.claude/agents/architect-review.md` exists and references your
      architecture/conventions docs.
- [ ] `.claude/agents/pm-review.md` exists and references your
      product/PRD docs.
- [ ] Both personas declare they only write `review-architect.md` /
      `review-pm.md` and do NOT edit source. (Templates do this.)
- [ ] Both personas include the verdict invariant line:
      `**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP`.
- [ ] Your `prd.md` has a `## Relevant Files` section.

## Choosing a Backend
```

- [ ] **Step 3: Verify the new section landed correctly**

Run: `grep -n "Setting up guardian reviews" README.md`
Expected: one match.

Run: `grep -n "Choosing a Backend" README.md`
Expected: one match, on a line *after* the new section.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add 'Setting up guardian reviews' section to README"
```

---

## Task 4: Extract `runArchitectReview` helper

**Files:**
- Modify: `src/orchestrator.ts:979-1000` (the architect-review block).

This task is a pure refactor — no behavior change yet. We extract the inline architect-review code into a named helper but keep it sequential; PM still runs after. The next task parallelizes.

- [ ] **Step 1: Read the current block**

Use the Read tool on `src/orchestrator.ts:975-1025` to confirm exact text.

- [ ] **Step 2: Add the helper above the block**

Within the existing `try { ... } finally { ... }` that owns `reviewDir` (the block starting at the `// --- Pre-ship sanity gate ---` comment), extract the architect-review section into a helper.

Replace this block (currently at lines 979–1000):

```ts
        // Architect review
        const archLog = logger.agentLog("all", "architect-review");
        try {
          await invoke({
            role: "architect-review",
            agent: "architect-review",
            prompt: renderPrompt("architect-review", { SPECS_DIR: relSpecsDir, RELEVANT_FILES: relevantFilesBlock }),
            cwd: reviewDir,
            logStream: archLog,
          });
        } finally {
          await new Promise<void>((res) => archLog.end(() => res()));
        }

        const archPath = join(reviewDir, specsDir, "review-architect.md");
        const archVerdict = artifacts.readReviewVerdict(archPath);
        if (archVerdict === "UNKNOWN") {
          console.warn(
            `  ⚠️  Could not parse architect review verdict from ${archPath} — expected a "**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP" line. Treating as UNKNOWN (no PR will be opened).`,
          );
        }
        logger.setReviewVerdicts(archVerdict);
```

With this:

```ts
        const runArchitectReview = async (): Promise<artifacts.ReviewVerdict> => {
          const log = logger.agentLog("all", "architect-review");
          try {
            await invoke({
              role: "architect-review",
              agent: "architect-review",
              prompt: renderPrompt("architect-review", { SPECS_DIR: relSpecsDir, RELEVANT_FILES: relevantFilesBlock }),
              cwd: reviewDir,
              logStream: log,
            });
          } finally {
            await new Promise<void>((res) => log.end(() => res()));
          }
          const path = join(reviewDir, specsDir, "review-architect.md");
          const verdict = artifacts.readReviewVerdict(path);
          if (verdict === "UNKNOWN") {
            console.warn(
              `  ⚠️  Could not parse architect review verdict from ${path} — expected a "**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP" line. Treating as UNKNOWN (no PR will be opened).`,
            );
          }
          return verdict;
        };

        const archVerdict = await runArchitectReview();
        logger.setReviewVerdicts(archVerdict);
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (no new errors).

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`
Expected: PASS — this is a pure refactor; the failure-injection test at L756–833 still asserts the same `PipelineError` because we haven't switched to `Promise.allSettled` yet.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts
git commit -m "refactor: extract runArchitectReview helper in pipeline post-impl"
```

---

## Task 5: Extract `runPmReview` helper

**Files:**
- Modify: `src/orchestrator.ts` — the PM-review block immediately after the architect block (currently lines 1002–1023 in the original; will have shifted slightly after Task 4).

Same pattern as Task 4. Pure refactor; no behavior change.

- [ ] **Step 1: Locate the PM block**

Use Grep: `pmLog\.end` in `src/orchestrator.ts` to find the current location.

- [ ] **Step 2: Replace the inline PM block with a helper**

Replace this block:

```ts
        // PM review
        const pmLog = logger.agentLog("all", "pm-review");
        try {
          await invoke({
            role: "pm-review",
            agent: "pm-review",
            prompt: renderPrompt("pm-review", { SPECS_DIR: relSpecsDir, RELEVANT_FILES: relevantFilesBlock }),
            cwd: reviewDir,
            logStream: pmLog,
          });
        } finally {
          pmLog.end();
        }

        const pmPath = join(reviewDir, specsDir, "review-pm.md");
        const pmVerdict = artifacts.readReviewVerdict(pmPath);
        if (pmVerdict === "UNKNOWN") {
          console.warn(
            `  ⚠️  Could not parse PM review verdict from ${pmPath} — expected a "**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP" line. Treating as UNKNOWN (no PR will be opened).`,
          );
        }
        logger.setReviewVerdicts(undefined, pmVerdict);
```

With this:

```ts
        const runPmReview = async (): Promise<artifacts.ReviewVerdict> => {
          const log = logger.agentLog("all", "pm-review");
          try {
            await invoke({
              role: "pm-review",
              agent: "pm-review",
              prompt: renderPrompt("pm-review", { SPECS_DIR: relSpecsDir, RELEVANT_FILES: relevantFilesBlock }),
              cwd: reviewDir,
              logStream: log,
            });
          } finally {
            await new Promise<void>((res) => log.end(() => res()));
          }
          const path = join(reviewDir, specsDir, "review-pm.md");
          const verdict = artifacts.readReviewVerdict(path);
          if (verdict === "UNKNOWN") {
            console.warn(
              `  ⚠️  Could not parse PM review verdict from ${path} — expected a "**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP" line. Treating as UNKNOWN (no PR will be opened).`,
            );
          }
          return verdict;
        };

        const pmVerdict = await runPmReview();
        logger.setReviewVerdicts(undefined, pmVerdict);
```

Note: I'm intentionally upgrading the PM log cleanup to the same awaited form as architect — `await new Promise<void>((res) => log.end(() => res()))` — instead of the bare `pmLog.end()` the current code uses. This makes the two helpers symmetric and ensures the log fully flushes before the verdict is parsed.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts
git commit -m "refactor: extract runPmReview helper, symmetric with architect"
```

---

## Task 6: Update the failure-injection test for the new contract

**Files:**
- Modify: `src/orchestrator.test.ts:756-833` (the test titled "emits a PipelineError carrying the partial summary when an uncaught error fires mid-run").

Under the new contract (after Task 7 lands), a thrown architect-review will NOT emit a `PipelineError` — it'll surface as `UNKNOWN` and the pipeline returns normally. We update this test FIRST (before Task 7) so that when Task 7 lands, the test is already aligned with the new behavior.

This means: between Task 6 and Task 7, this test will be FAILING. That's intentional — it pins the new contract before we change the production code, in TDD style. The other tests still pass.

- [ ] **Step 1: Read the existing test**

Use Read on `src/orchestrator.test.ts:756-833` to confirm the structure.

- [ ] **Step 2: Rewrite the test**

Replace the test body (the entire `it(...)` block from line 756 to 833) with this:

```ts
  it("surfaces a thrown architect-review as UNKNOWN verdict without aborting the pipeline", async () => {
    const repo = makeRepo();
    const slug = "summary-throw";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "7001",
        title: "Passes then architect review explodes",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const dag = buildDAG(slices);

    const fixtures = new Map<string, SliceFixture>([
      [
        "7001",
        {
          files: ["src/y.txt"],
          qaPasses: true,
          outputFile: "src/y.txt",
          outputContent: "y",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const baseProvider = buildStubProvider({ fixtures, slices, records });

    // Wrap the stub so the architect-review invocation throws, but PM
    // review still runs (it's a no-op in the stub → UNKNOWN verdict).
    const explodingProvider: AgentProvider = {
      name: baseProvider.name,
      async invoke(options) {
        if (options.role === "architect-review") {
          throw new Error("simulated architect-review failure");
        }
        return baseProvider.invoke(options);
      },
    };

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag,
      provider: explodingProvider,
    });

    // Pipeline returns normally; the slice succeeded.
    expect(result.success).toBe(true);
    expect(result.consoleSummary).toContain(`AFK Pipeline Summary — ${slug}`);
    expect(result.consoleSummary).toMatch(/Succeeded \(1\)/);
    expect(result.consoleSummary).toContain("#7001");
    // No PR opened — neither verdict was SHIP/ACCEPT-WITH-NOTES.
    expect(result.consoleSummary).toContain("Not ready");
    // Summary file written.
    const summaryPath = join(repo, ".afk", "logs", `${slug}-stub`, "run-summary.md");
    expect(existsSync(summaryPath)).toBe(true);
  }, 60_000);

  it("surfaces both reviews failing as two UNKNOWN verdicts without aborting", async () => {
    const repo = makeRepo();
    const slug = "summary-both-throw";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "8001",
        title: "Passes then both reviews explode",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const dag = buildDAG(slices);

    const fixtures = new Map<string, SliceFixture>([
      [
        "8001",
        {
          files: ["src/z.txt"],
          qaPasses: true,
          outputFile: "src/z.txt",
          outputContent: "z",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const baseProvider = buildStubProvider({ fixtures, slices, records });

    const bothExplodingProvider: AgentProvider = {
      name: baseProvider.name,
      async invoke(options) {
        if (options.role === "architect-review") {
          throw new Error("simulated architect failure");
        }
        if (options.role === "pm-review") {
          throw new Error("simulated pm failure");
        }
        return baseProvider.invoke(options);
      },
    };

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag,
      provider: bothExplodingProvider,
    });

    // Pipeline still returns normally.
    expect(result.success).toBe(true);
    expect(result.consoleSummary).toMatch(/Succeeded \(1\)/);
    expect(result.consoleSummary).toContain("Not ready");
    const summaryPath = join(repo, ".afk", "logs", `${slug}-stub`, "run-summary.md");
    expect(existsSync(summaryPath)).toBe(true);
  }, 60_000);
```

- [ ] **Step 3: Run the updated tests — they should FAIL right now**

Run: `pnpm test:run -- orchestrator.test`
Expected: the two new tests FAIL with `PipelineError` being thrown by `runPipeline` (because Task 7 hasn't landed yet). All other tests in `orchestrator.test.ts` should still PASS.

If a test other than these two fails, stop and investigate before proceeding to Task 7.

- [ ] **Step 4: Commit (with failing tests)**

```bash
git add src/orchestrator.test.ts
git commit -m "test: pin new contract — review failure surfaces as UNKNOWN, no PipelineError

The two updated tests will fail until the orchestrator switches to
Promise.allSettled in the next commit. Pinning the contract first."
```

---

## Task 7: Switch to `Promise.allSettled` for the two reviews

**Files:**
- Modify: `src/orchestrator.ts` — the area where `runArchitectReview` and `runPmReview` are now called sequentially after Tasks 4–5.

This is the behavior-change task. After this lands, the tests from Task 6 turn green.

- [ ] **Step 1: Locate the current sequential calls**

Use Grep: `runArchitectReview\(\)` in `src/orchestrator.ts`. There should be one call site (added in Task 4) directly followed by the `runPmReview()` call site (added in Task 5).

- [ ] **Step 2: Replace the sequential pair with `Promise.allSettled`**

Replace this:

```ts
        const archVerdict = await runArchitectReview();
        logger.setReviewVerdicts(archVerdict);
```

…and the immediately-following…

```ts
        const pmVerdict = await runPmReview();
        logger.setReviewVerdicts(undefined, pmVerdict);
```

With:

```ts
        const [archSettled, pmSettled] = await Promise.allSettled([
          runArchitectReview(),
          runPmReview(),
        ]);

        const archVerdict: artifacts.ReviewVerdict =
          archSettled.status === "fulfilled" ? archSettled.value : "UNKNOWN";
        const pmVerdict: artifacts.ReviewVerdict =
          pmSettled.status === "fulfilled" ? pmSettled.value : "UNKNOWN";

        if (archSettled.status === "rejected") {
          console.warn(
            `  ⚠️  Architect review failed: ${archSettled.reason instanceof Error ? archSettled.reason.message : String(archSettled.reason)}. Treating as UNKNOWN (no PR will be opened).`,
          );
        }
        if (pmSettled.status === "rejected") {
          console.warn(
            `  ⚠️  PM review failed: ${pmSettled.reason instanceof Error ? pmSettled.reason.message : String(pmSettled.reason)}. Treating as UNKNOWN (no PR will be opened).`,
          );
        }

        logger.setReviewVerdicts(archVerdict, pmVerdict);
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test:run`
Expected: ALL PASS, including the two tests from Task 6 that were previously failing.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: run architect-review and pm-review concurrently

Both reviews share the post-impl worktree; templates declare a
read-only contract that makes shared-worktree parallelism safe. A
thrown review surfaces as UNKNOWN rather than aborting the pipeline,
so the surviving review still produces a verdict."
```

---

## Task 8: End-to-end smoke verification

This task verifies the full design works together. No new code; just runs the existing test suite once more and inspects the output.

- [ ] **Step 1: Full test pass**

Run: `pnpm test:run`
Expected: ALL PASS.

- [ ] **Step 2: Typecheck pass**

Run: `pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Lint pass**

Run: `pnpm lint`
Expected: PASS, no errors.

- [ ] **Step 4: Confirm both new template files are accessible**

Run:
```bash
ls -la templates/agents/
cat templates/agents/architect-review.md | head -20
cat templates/agents/pm-review.md | head -20
```
Expected: Both files exist; both start with the YAML frontmatter showing `name:` and `description:`.

- [ ] **Step 5: Confirm README section renders correctly**

Run: `grep -A 2 "Setting up guardian reviews" README.md | head -10`
Expected: shows the new heading and the first paragraph.

- [ ] **Step 6: No further commit**

Smoke verification only — no file changes.

---

## Done criteria

All of these must be true:

- [ ] `templates/agents/architect-review.md` exists with YAML frontmatter, read-only contract section, verdict invariant, and severity scheme.
- [ ] `templates/agents/pm-review.md` exists with the same structure but PM-flavored.
- [ ] `README.md` has a "Setting up guardian reviews" section between Agent Configuration and Choosing a Backend.
- [ ] `src/orchestrator.ts` runs the two reviews via `Promise.allSettled`.
- [ ] `pnpm test:run`, `pnpm typecheck`, and `pnpm lint` all pass.
- [ ] The review-failure test asserts the new contract (UNKNOWN verdict, no PipelineError, pipeline returns success).
- [ ] A new test covers both reviews failing simultaneously.
