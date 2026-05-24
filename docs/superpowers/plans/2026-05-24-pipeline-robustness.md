# AFK Pipeline Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the three failure modes that caused PRD 024 Wave 1 to land both slices in `Phase B returned ERROR`: (1) contract `Status` field never flipped to `LOCKED` so generator agents bail by their own invariant, (2) round-1 evaluator-qa always FAILs on empty work and burns a round, (3) idle-watchdog kills generators waiting on backgrounded test processes.

**Architecture:** Single source of truth on contract lock state — the orchestrator owns the literal text on disk; agent prompts read what they see. Round budget no longer wasted by Bug-1 fallout. Idle watcher keeps its semantics but is reset by Bash tool-call activity, not just stdout chunks.

**Tech Stack:** Node 20+ TypeScript, vitest, Node child_process (spawn), git worktrees. Project source in `C:\Code\afk\src\`, prompts in `C:\Code\afk\prompts\`, ADRs in `C:\Code\afk\docs\adr\`. Tests run with `pnpm test`.

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `src/artifacts.ts` | Contract/QA/review parsers. Strip the "ACCEPT-implies-LOCKED" shortcut from `readContractStatus`. Add `lockContract(path)` writer. | Modify |
| `src/artifacts.test.ts` | Existing parser tests + new `readContractStatus` cases for LOCKED-only acceptance + new `lockContract` tests. | Modify |
| `src/orchestrator.ts` | After `verdict === "ACCEPT"` flip Status on disk via `lockContract` before returning LOCKED. Raise `idleTimeoutMs` for `generator` and `evaluator-qa` (slow test suites). | Modify |
| `src/orchestrator.test.ts` | Add an end-to-end test: contract-evaluator returns ACCEPT but planner leaves NEGOTIATING — orchestrator must still proceed to generator with a LOCKED contract on disk. | Modify |
| `src/claude.ts` | Reset idle watcher on every parsed `tool_call` event (not just on stdout chunks — they already cover it; this is belt-and-braces for backgrounded tasks where the agent emits text BUT a long-running Bash returns nothing for minutes). Keep tool-call ceiling unchanged. | Modify |
| `src/claude.test.ts` | New test for the tool_call → idle reset wiring. | Modify (or create section) |
| `src/idle-watcher.ts` | No change — its `reset()` is already the right primitive. | Read only |
| `prompts/evaluator-contract.md` | Drop the "Planner: flip Status to LOCKED" instruction (no longer truthful — orchestrator owns it). | Modify |
| `prompts/planner.md` | Remove the `**Status:** NEGOTIATING` template seed and the "round budget" mention now that round 2 won't be wasted. Replace with a note that Status is owned by the orchestrator. | Modify |
| `docs/adr/0008-orchestrator-owns-contract-status.md` | New ADR explaining the single-source-of-truth shift. | Create |

Three concerns, three small surfaces. No new files in `src/` beyond docs/test edits — the plan deliberately avoids introducing a "contract state machine" or similar abstraction. The orchestrator already drives state; we just make it write what it knows.

---

## Task 1: Failing test — `readContractStatus` should NOT auto-LOCK on bare ACCEPT

**Files:**
- Test: `src/artifacts.test.ts`

- [ ] **Step 1: Write the failing test**

Add this `describe` block at the bottom of `src/artifacts.test.ts` (before the final closing `});` of the file). Reuse the existing `withContractFile` helper.

```typescript
import { readContractStatus } from "./artifacts.js";

describe("readContractStatus", () => {
  it("returns LOCKED when the Status field is literally LOCKED", () => {
    withContractFile(
      `# Slice Contract\n\n**Status:** LOCKED\n\n## Scope lock\nFoo.\n`,
      (p) => expect(readContractStatus(p)).toBe("LOCKED"),
    );
  });

  it("returns NEGOTIATING when Status is NEGOTIATING — even if evaluator wrote ACCEPT", () => {
    withContractFile(
      [
        `# Slice Contract`,
        ``,
        `**Status:** NEGOTIATING`,
        ``,
        `## Scope lock`,
        `Foo.`,
        ``,
        `## Evaluator feedback — round 1`,
        ``,
        `VERDICT: ACCEPT`,
      ].join("\n"),
      (p) => expect(readContractStatus(p)).toBe("NEGOTIATING"),
    );
  });

  it("returns NEGOTIATING when Status is missing entirely", () => {
    withContractFile(
      `# Slice Contract\n\n## Scope lock\nFoo.\n`,
      (p) => expect(readContractStatus(p)).toBe("NEGOTIATING"),
    );
  });

  it("returns UNKNOWN when the file is missing", () => {
    expect(readContractStatus("/nonexistent/path/contract.md")).toBe("UNKNOWN");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/artifacts.test.ts`
Expected: FAIL on the second case ("returns NEGOTIATING … even if evaluator wrote ACCEPT") — current code returns `"LOCKED"` because of the ACCEPT shortcut at `src/artifacts.ts:30-31`.

- [ ] **Step 3: Commit (test first)**

```bash
git add src/artifacts.test.ts
git commit -m "test(artifacts): pin readContractStatus to literal Status field"
```

---

## Task 2: Drop the ACCEPT-implies-LOCKED shortcut

**Files:**
- Modify: `src/artifacts.ts:20-45`

- [ ] **Step 1: Read current implementation**

Open `src/artifacts.ts` and confirm lines 20–45 match the existing `readContractStatus` body (the shortcut block is lines 28–32).

- [ ] **Step 2: Replace the function body**

Replace the entire `readContractStatus` function (`src/artifacts.ts:20-45`) with:

```typescript
export function readContractStatus(contractPath: string): ContractStatus {
  const content = readIfExists(contractPath);
  if (!content) return "UNKNOWN";

  const status = matchField(content, /\*\*Status:\*\*\s*(\S+)/i);
  if (!status) return "NEGOTIATING";

  const upper = status.toUpperCase();
  if (upper === "LOCKED") return "LOCKED";
  if (upper === "DRAFT") return "DRAFT";
  return "NEGOTIATING";
}
```

The change: no implicit promotion based on evaluator verdict. Status field is the only signal.

- [ ] **Step 3: Run tests to verify Task 1 passes**

Run: `pnpm vitest run src/artifacts.test.ts`
Expected: All `readContractStatus` cases PASS. Existing parser tests still PASS.

- [ ] **Step 4: Commit**

```bash
git add src/artifacts.ts
git commit -m "fix(artifacts): readContractStatus reads the Status field only"
```

---

## Task 3: Failing test — `lockContract` writer

**Files:**
- Test: `src/artifacts.test.ts`

- [ ] **Step 1: Add the test block**

Append to the `describe("readContractStatus", ...)` block introduced in Task 1 (or as a new sibling `describe`):

```typescript
import { lockContract } from "./artifacts.js";

describe("lockContract", () => {
  it("flips **Status:** NEGOTIATING to LOCKED in place", () => {
    withContractFile(
      `# Slice\n\n**Status:** NEGOTIATING\n**Negotiation round:** 1\n\n## Scope lock\nFoo.\n`,
      (p) => {
        lockContract(p);
        expect(readContractStatus(p)).toBe("LOCKED");
        const content = readFileSync(p, "utf-8");
        expect(content).toContain("**Status:** LOCKED");
        expect(content).not.toContain("**Status:** NEGOTIATING");
        // Other fields preserved.
        expect(content).toContain("**Negotiation round:** 1");
        expect(content).toContain("## Scope lock");
      },
    );
  });

  it("is idempotent when Status is already LOCKED", () => {
    withContractFile(
      `# Slice\n\n**Status:** LOCKED\n\n## Scope lock\nFoo.\n`,
      (p) => {
        lockContract(p);
        const content = readFileSync(p, "utf-8");
        expect(content.match(/\*\*Status:\*\*/g)?.length).toBe(1);
      },
    );
  });

  it("inserts the Status field if absent (defensive — should never happen in prod)", () => {
    withContractFile(`# Slice Contract\n\n## Scope lock\nFoo.\n`, (p) => {
      lockContract(p);
      expect(readContractStatus(p)).toBe("LOCKED");
    });
  });
});
```

Add the missing `readFileSync` import at the top of the test file if not already present:

```typescript
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/artifacts.test.ts`
Expected: FAIL with `lockContract is not a function` (or import error).

- [ ] **Step 3: Commit**

```bash
git add src/artifacts.test.ts
git commit -m "test(artifacts): pin lockContract write semantics"
```

---

## Task 4: Implement `lockContract`

**Files:**
- Modify: `src/artifacts.ts`

- [ ] **Step 1: Add the import for `writeFileSync`**

At the top of `src/artifacts.ts`, change:

```typescript
import { readFileSync, existsSync } from "node:fs";
```

to:

```typescript
import { existsSync, readFileSync, writeFileSync } from "node:fs";
```

- [ ] **Step 2: Add the `lockContract` function**

Append at the end of `src/artifacts.ts`:

```typescript
/**
 * Write `**Status:** LOCKED` into `contract.md`. Replaces an existing
 * Status line in place; inserts one after the H1 heading if absent.
 *
 * Owned by the orchestrator: callers run this after the contract
 * evaluator returns `ACCEPT`. Agents do not edit Status. See ADR 0008.
 */
export function lockContract(contractPath: string): void {
  const content = existsSync(contractPath)
    ? readFileSync(contractPath, "utf-8")
    : "";

  const statusRe = /^\*\*Status:\*\*\s*\S+\s*$/im;
  let next: string;

  if (statusRe.test(content)) {
    next = content.replace(statusRe, "**Status:** LOCKED");
  } else if (content.length > 0) {
    // Insert after the first H1, or prepend if no H1.
    const h1 = content.match(/^#\s+.+$/m);
    if (h1 && h1.index !== undefined) {
      const at = h1.index + h1[0].length;
      next = content.slice(0, at) + "\n\n**Status:** LOCKED" + content.slice(at);
    } else {
      next = "**Status:** LOCKED\n\n" + content;
    }
  } else {
    next = "**Status:** LOCKED\n";
  }

  writeFileSync(contractPath, next, "utf-8");
}
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run src/artifacts.test.ts`
Expected: All `lockContract` and `readContractStatus` tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/artifacts.ts
git commit -m "feat(artifacts): add lockContract writer for orchestrator-owned status"
```

---

## Task 5: Failing orchestrator test — orchestrator must lock contract after ACCEPT

**Files:**
- Test: `src/orchestrator.test.ts`

- [ ] **Step 1: Locate the right place in the file**

Open `src/orchestrator.test.ts`. Find the existing `buildStubProvider` factory (around line 283). Read the existing planner branch — note that the stub currently writes a contract with a Status line. We need a fixture variant where **the planner writes `Status: NEGOTIATING` and the evaluator writes `VERDICT: ACCEPT` but never flips Status**.

- [ ] **Step 2: Add a focused integration test**

Append a new `describe("orchestrator-owned contract status", ...)` block at the end of the file (before the file's final closing `});` if any, or at the bottom). It uses `runPipeline` end-to-end with a stub provider.

```typescript
import { runPipeline } from "./orchestrator.js";

describe("orchestrator-owned contract status", () => {
  it("locks the contract on ACCEPT even when planner leaves Status NEGOTIATING", async () => {
    const repo = makeRepo();
    const { specsDir } = writePrdFixture(repo, "024-test");
    const slices: Slice[] = [
      {
        ghIssue: "1",
        number: "01",
        title: "first slice",
        depsRaw: "",
        deps: [],
      },
    ];

    const fixtures = new Map<string, SliceFixture>([
      [
        "1",
        {
          files: ["src/foo.txt"],
          qaPasses: true,
          outputFile: "src/foo.txt",
          outputContent: "ok\n",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const provider = buildStubProvider({ fixtures, slices, records });

    // Wrap provider.invoke so the "planner" stub writes NEGOTIATING and
    // the "evaluator-contract" stub writes VERDICT: ACCEPT — but neither
    // touches Status. Mirrors the real-world prompt failure.
    const buggyProvider: AgentProvider = {
      ...provider,
      async invoke(opts: InvokeOptions): Promise<InvokeResult> {
        if (opts.role === "planner") {
          const sliceDir = findSliceArtifactDir(opts.cwd, "01")!;
          writeFileSync(
            join(sliceDir, "contract.md"),
            [
              "# Slice Contract — first slice",
              "",
              "**Status:** NEGOTIATING",
              "**Negotiation round:** 1",
              "",
              "## Files expected to change",
              "- src/foo.txt",
              "",
              "## Scope lock",
              "trivial",
              "",
            ].join("\n"),
            "utf-8",
          );
          return { exitCode: 0, stdout: "", stats: {} };
        }
        if (opts.role === "evaluator-contract") {
          const sliceDir = findSliceArtifactDir(opts.cwd, "01")!;
          const path = join(sliceDir, "contract.md");
          const cur = readFileSync(path, "utf-8");
          writeFileSync(path, cur + "\n## Evaluator feedback — round 1\n\nVERDICT: ACCEPT\n", "utf-8");
          return { exitCode: 0, stdout: "", stats: {} };
        }
        // For all other roles defer to the original stub.
        return provider.invoke(opts);
      },
    };

    await runPipeline({
      repoRoot: repo,
      prdSlug: "024-test",
      specsDir,
      provider: buggyProvider,
      // Pin everything else to the test-fixture defaults already in this file.
    } as Parameters<typeof runPipeline>[0]);

    // After Phase A returns LOCKED, the contract on disk must actually
    // show **Status:** LOCKED — otherwise the generator's invariant
    // ("if Status is not LOCKED, stop") fires.
    const wt = join(repo, ".afk", "worktrees");
    const sliceDirs = readdirSync(wt).filter((d) => d.includes("-s01"));
    expect(sliceDirs.length).toBe(1);
    const contractPath = join(
      wt,
      sliceDirs[0]!,
      specsDir,
      "slices",
      "01-first-slice",
      "contract.md",
    );
    const content = readFileSync(contractPath, "utf-8");
    expect(content).toMatch(/^\*\*Status:\*\*\s*LOCKED\s*$/m);
    expect(content).not.toMatch(/\*\*Status:\*\*\s*NEGOTIATING/);

    // Sanity: a generator was invoked (Phase B reached) — proves the
    // orchestrator did not bail on NEGOTIATING.
    expect(records.some((r) => r.role === "generator")).toBe(true);
  });
});
```

If `runPipeline` requires more options than shown, copy the option shape from the existing test that exercises `runPipeline` in this file (search for `runPipeline(` to find it).

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/orchestrator.test.ts -t "orchestrator-owned contract status"`
Expected: FAIL — current orchestrator does not call `lockContract`, so `**Status:** NEGOTIATING` remains on disk.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator.test.ts
git commit -m "test(orchestrator): pin contract-locking on evaluator ACCEPT"
```

---

## Task 6: Make the orchestrator lock the contract on ACCEPT

**Files:**
- Modify: `src/orchestrator.ts:506-526`

- [ ] **Step 1: Edit `runSliceNegotiate`**

In `src/orchestrator.ts`, find the negotiation loop body. Replace lines 506–518 (the verdict/status check inside the `for` loop) with:

```typescript
        const verdict = artifacts.readEvaluatorVerdict(contractPath);
        if (verdict === "ACCEPT") {
          artifacts.lockContract(contractPath);
          contractStatus = "LOCKED";
          break;
        }
        contractStatus = artifacts.readContractStatus(contractPath);
        if (contractStatus === "LOCKED") break;
        if (verdict === "ESCALATE" || round === MAX_CONTRACT_ROUNDS) {
          console.error(`${ctx.tag}: ESCALATE — contract negotiation failed`);
          logger.bumpEvalRound(slice.ghIssue, round);
          logger.markEscalated(
            slice.ghIssue,
            "Contract negotiation escalated after max rounds",
          );
          return "ESCALATE";
        }
```

The post-loop check at lines 521–525 still serves as the safety net.

- [ ] **Step 2: Run the failing orchestrator test**

Run: `pnpm vitest run src/orchestrator.test.ts -t "orchestrator-owned contract status"`
Expected: PASS.

- [ ] **Step 3: Run full test suite for regressions**

Run: `pnpm test`
Expected: All tests PASS. If any pre-existing tests asserted on the ACCEPT-implies-LOCKED shortcut, update them to reflect the new contract (the orchestrator explicitly writes LOCKED).

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator.ts
git commit -m "fix(orchestrator): lock contract on evaluator ACCEPT instead of waiting on planner"
```

---

## Task 7: Update prompts so they no longer claim the planner owns Status

**Files:**
- Modify: `prompts/evaluator-contract.md:46-51`
- Modify: `prompts/planner.md:23-52`

- [ ] **Step 1: Edit `prompts/evaluator-contract.md`**

Replace lines 48–51 (the "If ACCEPT" block):

```
### If ACCEPT:
Contract is testable, UAT-verifiable, and feasible in one session.
Planner: flip Status to LOCKED.
```

with:

```
### If ACCEPT:
Contract is testable, UAT-verifiable, and feasible in one session.
The orchestrator will flip **Status:** to LOCKED automatically — you do not need to.
```

- [ ] **Step 2: Edit `prompts/planner.md`**

Find the Invariants block (lines 23–27) that says:

```
- The `**Status:**` field (`NEGOTIATING` or `LOCKED`) is parsed by the
  orchestrator. Always include it exactly as shown in the template.
```

Replace it with:

```
- Always seed the `**Status:** NEGOTIATING` line in your output. The
  orchestrator flips it to `LOCKED` after the contract evaluator
  ACCEPTs — never write `LOCKED` yourself.
```

The template seed at line 51 (`**Status:** NEGOTIATING`) stays unchanged.

- [ ] **Step 3: Verify no other prompt references the old behavior**

Run: `pnpm exec rg -n "flip Status|flip.*LOCKED" prompts/`
Expected: no results. If matches appear, update them to align with the orchestrator-owns-Status model.

- [ ] **Step 4: Commit**

```bash
git add prompts/evaluator-contract.md prompts/planner.md
git commit -m "docs(prompts): orchestrator owns contract Status, not the planner"
```

---

## Task 8: Failing test — `handleStreamEvent` resets watcher on tool_call

**Files:**
- Modify: `src/claude.test.ts`

We test by extracting the per-event handler into a small exported helper (Task 9) and unit-testing that helper. This avoids the gnarly `child_process.spawn` mocking that would otherwise be needed and gives a fast, deterministic test.

- [ ] **Step 1: Add the failing test**

Append this `describe` block at the end of `src/claude.test.ts`:

```typescript
import { handleStreamEvent } from "./claude.js";
import type { StreamEvent } from "./agent-provider.js";

describe("handleStreamEvent", () => {
  function makeCounters() {
    const resets: number[] = [];
    const events: StreamEvent[] = [];
    return {
      watcher: {
        reset: () => resets.push(Date.now()),
        stop: () => {},
      },
      onStreamEvent: (e: StreamEvent) => events.push(e),
      resets,
      events,
    };
  }

  it("calls watcher.reset() for a tool_call event", () => {
    const c = makeCounters();
    const result = handleStreamEvent({
      event: { type: "tool_call", name: "Bash", args: "echo x" },
      watcher: c.watcher,
      toolCallCount: 0,
      maxToolCalls: 100,
      onStreamEvent: c.onStreamEvent,
    });
    expect(c.resets.length).toBe(1);
    expect(result.toolCallCount).toBe(1);
    expect(result.capExceeded).toBe(false);
    expect(c.events).toEqual([{ type: "tool_call", name: "Bash", args: "echo x" }]);
  });

  it("does NOT call watcher.reset() for a text event", () => {
    const c = makeCounters();
    handleStreamEvent({
      event: { type: "text", text: "thinking..." },
      watcher: c.watcher,
      toolCallCount: 0,
      maxToolCalls: 100,
      onStreamEvent: c.onStreamEvent,
    });
    expect(c.resets.length).toBe(0);
  });

  it("flags capExceeded when tool calls exceed maxToolCalls", () => {
    const c = makeCounters();
    const result = handleStreamEvent({
      event: { type: "tool_call", name: "Bash", args: "x" },
      watcher: c.watcher,
      toolCallCount: 100,
      maxToolCalls: 100,
      onStreamEvent: c.onStreamEvent,
    });
    expect(result.toolCallCount).toBe(101);
    expect(result.capExceeded).toBe(true);
  });

  it("forwards the event to onStreamEvent before counting", () => {
    const c = makeCounters();
    handleStreamEvent({
      event: { type: "result", result: "done" },
      watcher: c.watcher,
      toolCallCount: 0,
      maxToolCalls: 100,
      onStreamEvent: c.onStreamEvent,
    });
    expect(c.events).toEqual([{ type: "result", result: "done" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/claude.test.ts -t "handleStreamEvent"`
Expected: FAIL with `handleStreamEvent is not a function` (or import error).

- [ ] **Step 3: Commit**

```bash
git add src/claude.test.ts
git commit -m "test(claude): pin handleStreamEvent — tool_call resets idle watcher"
```

---

## Task 9: Extract `handleStreamEvent` and reset watcher on tool_call

**Files:**
- Modify: `src/claude.ts`

- [ ] **Step 1: Add the exported helper**

Add this function in `src/claude.ts`, right above the existing `export function invoke(...)` declaration (around line 99):

```typescript
/**
 * Per-event handler for the parsed stream. Centralises the idle-watcher
 * reset and the tool-call cap so they can be unit-tested without
 * spawning a child process. See ADR 0008.
 *
 * Idle reset on `tool_call` matters because the agent may emit a Bash
 * tool_call and then wait silently while the harness backgrounds the
 * command — chunks of stdout from the agent stop, but the session is
 * healthy. Without this reset, a long `pnpm test` invocation would
 * trip the idle floor and the agent would be killed mid-implementation.
 */
export function handleStreamEvent(args: {
  event: StreamEvent;
  watcher: { reset: () => void };
  toolCallCount: number;
  maxToolCalls: number;
  onStreamEvent?: (e: StreamEvent) => void;
}): { toolCallCount: number; capExceeded: boolean } {
  const { event, watcher, maxToolCalls, onStreamEvent } = args;
  let { toolCallCount } = args;
  let capExceeded = false;

  if (event.type === "tool_call") {
    watcher.reset();
    toolCallCount++;
    if (toolCallCount > maxToolCalls) capExceeded = true;
  }

  onStreamEvent?.(event);
  return { toolCallCount, capExceeded };
}
```

- [ ] **Step 2: Use the helper inside `invoke`**

Replace lines 206–217 of `src/claude.ts` (the `for (const event of parseStreamLine(line))` block) with:

```typescript
        for (const event of parseStreamLine(line)) {
          const next = handleStreamEvent({
            event,
            watcher,
            toolCallCount,
            maxToolCalls,
            onStreamEvent,
          });
          toolCallCount = next.toolCallCount;
          if (next.capExceeded && !toolCapExceeded) {
            toolCapExceeded = true;
            killed = true;
            proc.kill("SIGTERM");
            scheduleForceKill();
          }
        }
```

The visible behavior change: every `tool_call` event resets the idle watcher. The cap still fires when the count exceeds `maxToolCalls`.

- [ ] **Step 3: Run the focused test**

Run: `pnpm vitest run src/claude.test.ts -t "handleStreamEvent"`
Expected: PASS — all four cases.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: All PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/claude.ts
git commit -m "fix(claude): reset idle watcher on tool_call events to survive long-running tools"
```

---

## Task 10: Raise default idle timeout for generator and evaluator-qa

**Files:**
- Modify: `src/orchestrator.ts:560-575, 580-590`

- [ ] **Step 1: Define the longer timeout**

At the top of `src/orchestrator.ts` (next to the existing `MAX_CONTRACT_ROUNDS = 3` constants around line 23), add:

```typescript
/**
 * Idle timeout for generator and evaluator-qa invocations. These two
 * roles routinely shell out to a project's full test suite, which on
 * larger codebases can produce no stdout for several minutes (vitest
 * collecting fixtures, Jest type-checking). The provider default of
 * 180 s is too tight; 600 s avoids killing healthy sessions without
 * sacrificing the wedge-detection role of the floor. See ADR 0008.
 */
const SLOW_AGENT_IDLE_TIMEOUT_MS = 600_000;
```

- [ ] **Step 2: Pass the timeout into the generator invoke**

In `runSliceExecute` (`src/orchestrator.ts:561-574`), in the `await invoke({ role: "generator", ... })` call, add the `idleTimeoutMs` field:

```typescript
      await invoke({
        role: "generator",
        prompt: renderPrompt("generator", {
          SLICE_DIR: ctx.relSliceDir,
          RELEVANT_FILES: relevantFilesBlock,
          TEST_COMMAND: ctx.testCommand,
          RETRY_NOTE:
            round > 1
              ? `This is retry round ${round}. Read ${ctx.relSliceDir}/qa-report.md for findings to fix.`
              : "",
        }),
        cwd: ctx.worktreeDir,
        logStream: genLog,
        idleTimeoutMs: SLOW_AGENT_IDLE_TIMEOUT_MS,
      });
```

- [ ] **Step 3: Pass the timeout into the evaluator-qa invoke**

In the same function (`src/orchestrator.ts:581-590`), in the `await invoke({ role: "evaluator-qa", ... })` call, add the same field:

```typescript
      await invoke({
        role: "evaluator-qa",
        prompt: renderPrompt("evaluator-qa", {
          SLICE_DIR: ctx.relSliceDir,
          RELEVANT_FILES: relevantFilesBlock,
          TEST_COMMAND: ctx.testCommand,
        }),
        cwd: ctx.worktreeDir,
        logStream: evalLog,
        idleTimeoutMs: SLOW_AGENT_IDLE_TIMEOUT_MS,
      });
```

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: All PASS. (Existing tests do not assert on `idleTimeoutMs`; provider stubs ignore it.)

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts
git commit -m "fix(orchestrator): raise idle timeout for generator and evaluator-qa to 10m"
```

---

## Task 11: Add ADR documenting the contract-status ownership shift

**Files:**
- Create: `docs/adr/0008-orchestrator-owns-contract-status.md`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0008-orchestrator-owns-contract-status.md`:

```markdown
# Orchestrator owns contract Status; idle watcher resets on tool calls

**Date:** 2026-05-24

## Context

PRD 024 Wave 1 produced two slices stuck in `Phase B returned ERROR`
(`#271`, `#274`) after 36 minutes. Postmortem (see
`.afk/logs/024-lead-triage-view-claude-code/run-summary.md`) found
three compounding bugs:

1. The contract evaluator returned `VERDICT: ACCEPT` and instructed
   the planner to "flip Status to LOCKED" — but the planner's next
   round never runs once the verdict is ACCEPT, so Status stayed at
   `NEGOTIATING` on disk.
2. The orchestrator's `readContractStatus` papered over (1) by
   treating ACCEPT as implicitly LOCKED, but the **generator prompt**
   reads the literal Status field and bails by its own invariant
   ("If `contract.md` Status is not `LOCKED`, stop and report
   immediately"). Round 1 produced no code; the empty worktree
   trivially failed evaluator-qa round 1 and burned the round.
3. On round 2, the generator wrote real code, then ran the full test
   suite via Bash. The harness backgrounded the long-running command;
   the agent waited silently for results. The 3-minute idle floor
   (ADR 0007) fired and killed the session before any commit.

## Decision

**Single source of truth on contract lock state lives in the
orchestrator.** After `evaluator-contract` returns ACCEPT,
`runSliceNegotiate` calls `lockContract(path)` (new in
`src/artifacts.ts`) which writes `**Status:** LOCKED` directly. Agent
prompts no longer claim Status is the planner's responsibility, and
`readContractStatus` no longer infers LOCKED from evaluator verdicts.

**Idle watcher resets on parsed `tool_call` events**, not just on
stdout chunks. A backgrounded Bash command produces no stdout from
the agent's perspective, so the previous reset path missed it. The
tool-call ceiling (ADR 0007) is unaffected — the cap still fires on
runaway loops.

**Generator and evaluator-qa default to a 10-minute idle floor**
(`SLOW_AGENT_IDLE_TIMEOUT_MS`). Other roles keep the 3-minute
provider default; both roles can override per-invocation.

## Consequences

- Contract lock state is unambiguous on disk. Agents and the
  orchestrator agree on what the file says.
- A round of negotiation isn't wasted on a foregone-conclusion FAIL.
- Long test suites no longer trip the idle floor mid-run.
- The `lockContract` writer is small and idempotent, so reruns of
  Phase A on a previously-locked contract are safe.

## Alternatives considered

- **Prompt-side fix:** make `evaluator-contract` flip Status when it
  ACCEPTs. Rejected — agents are inconsistent at file edits, and the
  same agent grading itself for compliance is a bad audit trail.
- **Stricter `readContractStatus`:** keep the ACCEPT shortcut but
  warn loudly. Rejected — the divergence between disk and
  orchestrator state was the root cause, not the symptom.
- **Tool-call counter as idle reset signal:** reset only on the
  first tool_call per minute. Rejected — adds state for no real
  benefit; tool_calls are already cheap to count.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0008-orchestrator-owns-contract-status.md
git commit -m "docs(adr): 0008 — orchestrator owns contract Status, idle reset on tool_call"
```

---

## Task 12: Final verification

**Files:** none

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: All tests PASS, no regressions.

- [ ] **Step 2: Run typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Sanity-check the diff**

Run: `git log --oneline main..HEAD`

Expected commit list (order may differ):

1. `test(artifacts): pin readContractStatus to literal Status field`
2. `fix(artifacts): readContractStatus reads the Status field only`
3. `test(artifacts): pin lockContract write semantics`
4. `feat(artifacts): add lockContract writer for orchestrator-owned status`
5. `test(orchestrator): pin contract-locking on evaluator ACCEPT`
6. `fix(orchestrator): lock contract on evaluator ACCEPT instead of waiting on planner`
7. `docs(prompts): orchestrator owns contract Status, not the planner`
8. `test(claude): pin idle-watcher reset on tool_call events`
9. `fix(claude): reset idle watcher on tool_call events to survive long-running tools`
10. `fix(orchestrator): raise idle timeout for generator and evaluator-qa to 10m`
11. `docs(adr): 0008 — orchestrator owns contract Status, idle reset on tool_call`

- [ ] **Step 4: No commit — work is complete**

If everything is green, the branch is ready for PR. The changes scope is:

- `src/artifacts.ts` (+ test): one function rewritten, one new function.
- `src/orchestrator.ts` (+ test): three small edits — lockContract call, two `idleTimeoutMs` overrides, one new constant.
- `src/claude.ts` (+ test): one watcher.reset() added.
- `prompts/evaluator-contract.md`, `prompts/planner.md`: copy edits.
- `docs/adr/0008-...md`: new ADR.

No new files in `src/`. No abstraction layers. No state machines.
