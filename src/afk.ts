#!/usr/bin/env node
import { resolve, basename, join } from "node:path";
import { existsSync } from "node:fs";
import { parseIssuesMd, buildDAG } from "./issues-parser.js";
import {
  runPipeline,
  PipelineError,
  type MigrationValidation,
} from "./orchestrator.js";
import {
  DEFAULT_MAX_CONTRACT_ROUNDS,
  parseMaxContractRounds,
  parseSliceSelection,
} from "./cli-options.js";
import { parsePipelineRuntimeOptions } from "./cli-options.js";
import { runCleanFailedCli } from "./clean-failed.js";
import { resolveRunScope } from "./slice-scope.js";
import { assertPrdNotOnHold } from "./prd-hold.js";
import { runStatus } from "./status.js";

const MIGRATION_MODES: ReadonlyArray<MigrationValidation> = [
  "skip",
  "local-stack",
  "linked",
];

function usage(): never {
  console.error(
    `Usage: afk --prd-dir <path-to-prd-folder> [--dry-run] [--slices <01,02,...>] [--max-contract-rounds <n>] [--migration-validation <skip|local-stack|linked>] [--command-timeout-ms <n>] [--heartbeat-interval-ms <n>] [--infrastructure-retries <n>] [--transient-retry-window-ms <n>] [--max-agent-duration-ms <n>] [--open-pr-on-override] [--preview-verify-command <cmd> --preview-apply-command <cmd> [--preview-lock-path <path>]]\n       afk status [--run <dir>] [--json]\n       afk clean-failed --prd-dir <path-to-prd-folder> [--dry-run]`,
  );
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);

  // Subcommand dispatch (bare first token) — handled before flag
  // parsing; the pipeline flags below don't apply.
  //
  // `status` is the one-shot, read-only run view (spec #26).
  if (args[0] === "status") {
    const { output, exitCode } = runStatus(args.slice(1), resolve("."));
    // Error output goes to stderr so it's distinguishable from the
    // rendered view (and from --json documents) in shell pipelines.
    (exitCode === 0 ? console.log : console.error)(output);
    process.exit(exitCode);
  }
  // `clean-failed` removes dead slice worktrees/branches left by
  // failed runs — see issue #19.
  if (args[0] === "clean-failed") {
    process.exit(runCleanFailedCli(args.slice(1)));
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
  let maxContractRounds = DEFAULT_MAX_CONTRACT_ROUNDS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prd-dir" && args[i + 1]) {
      prdDirArg = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
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

  console.log(`AFK Pipeline`);
  console.log(`  PRD: ${prdSlug}`);
  console.log(`  PRD dir: ${prdDir}`);
  console.log(`  Repo: ${repoRoot}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log(`  Max contract rounds: ${maxContractRounds}`);
  console.log(
    `  Requested slices: ${selectedSliceNumbers?.join(", ") ?? "all AFK"}`,
  );
  console.log();

  // Parse issues and build DAG
  const slices = parseIssuesMd(issuesPath);
  const dag = buildDAG(slices);
  const previewScope = resolveRunScope(slices, selectedSliceNumbers);
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

  // Show DAG
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

    const completed = new Set<string>();
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

  // Run the pipeline. SIGINT triggers an AbortController so in-flight
  // agent invocations are killed and remaining slices are marked
  // CANCELLED. A second Ctrl-C lets the default handler kill the
  // process hard.
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
    // A blocked ship verdict or a failed pre-ship sanity gate is a failure
    // even when every slice passed, and `failureReason` is the only place
    // that says so (issue #43).
    console.error(
      result.failureReason
        ? `\nPipeline did not ship: ${result.failureReason}`
        : "\nPipeline completed with failures. Check logs and stuck.md files.",
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
