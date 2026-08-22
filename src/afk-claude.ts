#!/usr/bin/env node
import { resolve, basename, join } from "node:path";
import { existsSync } from "node:fs";
import { parseIssuesMd, buildDAG } from "./issues-parser.js";
import {
  runPipeline,
  narrowToFailedSlices,
  PipelineError,
  type MigrationValidation,
} from "./orchestrator.js";
import {
  DEFAULT_MAX_CONTRACT_ROUNDS,
  parseMaxContractRounds,
  parseSliceSelection,
} from "./cli-options.js";
import {
  resolveRunScope,
  type PersistedRunScope,
} from "./slice-scope.js";
import { parsePipelineRuntimeOptions } from "./cli-options.js";
import { assertPrdNotOnHold } from "./prd-hold.js";
import { runCleanFailedCli } from "./clean-failed.js";
import { claudeProvider } from "./claude.js";

const MIGRATION_MODES: ReadonlyArray<MigrationValidation> = [
  "skip",
  "local-stack",
  "linked",
];

function usage(): never {
  console.error(
    `Usage: afk-claude --prd-dir <path-to-prd-folder> [--dry-run] [--slices <01,02,...>] [--only-failed] [--max-contract-rounds <n>] [--migration-validation <skip|local-stack|linked>] [--command-timeout-ms <n>] [--heartbeat-interval-ms <n>] [--infrastructure-retries <n>] [--transient-retry-window-ms <n>] [--max-agent-duration-ms <n>] [--open-pr-on-override] [--preview-verify-command <cmd> --preview-apply-command <cmd> [--preview-lock-path <path>]]\n       afk-claude clean-failed --prd-dir <path-to-prd-folder> [--dry-run]`,
  );
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  // Subcommand dispatch (bare first token). `clean-failed` removes dead
  // slice worktrees/branches left by failed runs — see issue #19.
  if (args[0] === "clean-failed") {
    process.exit(runCleanFailedCli(args.slice(1), claudeProvider));
  }
  let runtimeOptions;
  try {
    runtimeOptions = parsePipelineRuntimeOptions(args);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(2);
  }

  let prdDirArg: string | undefined;
  let dryRun = false;
  let migrationValidation: MigrationValidation | undefined;
  let selectedSliceNumbers: string[] | undefined;
  let onlyFailed = false;
  let maxContractRounds = DEFAULT_MAX_CONTRACT_ROUNDS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prd-dir" && args[i + 1]) {
      prdDirArg = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--only-failed") {
      onlyFailed = true;
    } else if (args[i] === "--slices") {
      try {
        selectedSliceNumbers = parseSliceSelection(args[++i]);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(2);
      }
    } else if (args[i] === "--max-contract-rounds") {
      try {
        maxContractRounds = parseMaxContractRounds(args[++i]);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(2);
      }
    } else if (args[i] === "--migration-validation" && args[i + 1]) {
      const mode = args[++i] as MigrationValidation;
      if (!MIGRATION_MODES.includes(mode)) {
        console.error(
          `Error: --migration-validation must be one of ${MIGRATION_MODES.join(", ")}`,
        );
        process.exit(2);
      }
      migrationValidation = mode;
    } else if (args[i] === "--help" || args[i] === "-h") {
      usage();
    }
  }

  if (!prdDirArg) usage();
  if (onlyFailed && selectedSliceNumbers) {
    console.error(
      "Error: --only-failed cannot be combined with --slices; it derives the selection from the persisted run scope",
    );
    process.exit(2);
  }

  const prdDir = resolve(prdDirArg);
  const repoRoot = resolve(".");

  if (!existsSync(join(prdDir, "prd.md"))) {
    console.error(`Error: ${prdDir}/prd.md not found`);
    process.exit(2);
  }
  if (!existsSync(join(prdDir, "issues.md"))) {
    console.error(`Error: ${prdDir}/issues.md not found`);
    process.exit(2);
  }
  assertPrdNotOnHold(prdDir);

  const prdSlug = basename(prdDir);
  const specsDir = prdDir
    .replace(repoRoot + "\\", "")
    .replace(repoRoot + "/", "")
    .replace(/\\/g, "/");
  const issuesPath = join(prdDir, "issues.md");

  console.log(`AFK Pipeline (Claude Code backend)`);
  console.log(`  PRD: ${prdSlug}`);
  console.log(`  PRD dir: ${prdDir}`);
  console.log(`  Repo: ${repoRoot}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log(`  Max contract rounds: ${maxContractRounds}`);
  // `--only-failed` is resolved here as well as inside the pipeline, from
  // the same run state through the same helper, so the header line and
  // the --dry-run plan name exactly the slices the run will dispatch.
  let requestedSliceNumbers = selectedSliceNumbers;
  let previewPersistedScope: PersistedRunScope | undefined;
  let priorCompleted = new Set<string>();
  if (onlyFailed) {
    try {
      const narrowing = narrowToFailedSlices(repoRoot, prdSlug, claudeProvider);
      requestedSliceNumbers = narrowing.requestedSliceNumbers;
      previewPersistedScope = narrowing.persistedScope;
      priorCompleted = narrowing.priorCompleted;
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(2);
    }
  }
  console.log(
    `  Requested slices: ${
      onlyFailed
        ? `--only-failed → ${requestedSliceNumbers?.length ? requestedSliceNumbers.join(", ") : "none (every scope member is recorded PASS)"}`
        : (selectedSliceNumbers?.join(", ") ?? "all AFK")
    }`,
  );
  console.log();

  const slices = parseIssuesMd(issuesPath);
  const dag = buildDAG(slices);
  const previewScope = resolveRunScope(
    slices,
    requestedSliceNumbers,
    previewPersistedScope,
  );
  const previewDag = buildDAG(previewScope.selected);

  const afkCount = [...dag.slices.values()].filter(
    (s) => s.type === "AFK",
  ).length;
  const hitlCount = [...dag.slices.values()].filter(
    (s) => s.type === "HITL",
  ).length;
  console.log(
    `  Slices: ${slices.length} total (${afkCount} AFK, ${hitlCount} HITL)`,
  );

  console.log(`  Dependency graph:`);
  for (const [id, slice] of dag.slices) {
    const deps =
      slice.blockedBy.length > 0
        ? `← ${slice.blockedBy.map((d) => "#" + d).join(", ")}`
        : "(no deps)";
    const type = slice.type === "HITL" ? " [HITL — skipped]" : "";
    console.log(`    #${id} ${slice.title} ${deps}${type}`);
  }
  console.log();

  if (dryRun) {
    console.log("Dry run — showing execution plan only.\n");

    // Seeded with the run state's completed slices: the pipeline counts
    // those as satisfied dependencies, so the plan must too.
    const completed = new Set<string>(priorCompleted);
    let wave = 1;
    while (true) {
      const ready = previewDag.ready(completed);
      if (ready.length === 0) break;
      console.log(`  Wave ${wave}:`);
      for (const id of ready) {
        const slice = previewDag.slices.get(id)!;
        console.log(`    #${id} ${slice.title}`);
        completed.add(id);
      }
      wave++;
    }

    if (previewScope.skipped.length > 0) {
      console.log(`\n  Skipped:`);
      for (const { slice, reason } of previewScope.skipped) {
        console.log(`    #${slice.ghIssue} ${slice.title} (${reason})`);
      }
    }

    console.log("\nDry run complete. No changes made.");
    return;
  }

  console.log("Starting pipeline... (Ctrl-C to cancel)\n");
  const controller = new AbortController();
  let sigintCount = 0;
  const onSigint = () => {
    sigintCount++;
    if (sigintCount === 1) {
      console.error("\nReceived SIGINT — cancelling pipeline...");
      controller.abort();
    } else {
      console.error("Second SIGINT — exiting hard.");
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);

  let result;
  try {
    result = await runPipeline({
      repoRoot,
      prdSlug,
      prdDir,
      specsDir,
      dag,
      dryRun,
      maxContractRounds,
      selectedSliceNumbers,
      onlyFailed,
      provider: claudeProvider,
      migrationValidation,
      signal: controller.signal,
      ...runtimeOptions,
    });
  } catch (err) {
    process.off("SIGINT", onSigint);
    if (err instanceof PipelineError) {
      console.log("\n" + err.partialResult.consoleSummary);
      console.error("\nPipeline aborted by unhandled error:");
      console.error(err.cause instanceof Error ? err.cause.stack ?? err.cause.message : String(err.cause));
      process.exit(1);
    }
    throw err;
  }

  process.off("SIGINT", onSigint);

  console.log("\n" + result.consoleSummary);

  if (!result.success) {
    console.error(
      "\nPipeline completed with failures. Check logs and stuck.md files.",
    );
    process.exit(1);
  }

  console.log("\nPipeline completed successfully.");

  // A process that survived a kill (or a daemon an agent left behind)
  // can hold inherited stdio pipe handles open and wedge this event
  // loop at exit. Unref'd on purpose: a clean loop exits naturally
  // before the timer fires; a wedged loop is the only case where it
  // triggers. See ADR 0020.
  setTimeout(() => process.exit(0), 2_000).unref();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
