#!/usr/bin/env node
import { resolve, basename, join } from "node:path";
import { existsSync } from "node:fs";
import { parseIssuesMd, buildDAG } from "./issues-parser.js";
import {
  formatRunFailure,
  runPipeline,
  PipelineError,
} from "./orchestrator.js";
import type { MigrationValidation } from "./migration-gate.js";
import { kiroProvider } from "./kiro.js";
import {
  DEFAULT_MAX_CONTRACT_ROUNDS,
  parseMaxContractRounds,
  parseSliceSelection,
} from "./cli-options.js";
import { parsePipelineRuntimeOptions } from "./cli-options.js";
import { runCleanFailedCli } from "./clean-failed.js";
import { resolveCliRunScope } from "./cli-run-scope.js";
import { assertPrdNotOnHold } from "./prd-hold.js";
import { runStatus } from "./status.js";
import { runStatusWeb } from "./status-web.js";
import { loadAfkManifest } from "./afk-manifest.js";
import { installCancellationSignals } from "./cancellation.js";

const MIGRATION_MODES: ReadonlyArray<MigrationValidation> = [
  "skip",
  "local-stack",
  "linked",
];

function usage(): never {
  console.error(
    `Usage: afk --prd-dir <path-to-prd-folder> [--dry-run] [--slices <01,02,...>] [--only-failed] [--max-contract-rounds <n>] [--migration-validation <skip|local-stack|linked>] [--command-timeout-ms <n>] [--heartbeat-interval-ms <n>] [--infrastructure-retries <n>] [--transient-retry-window-ms <n>] [--max-agent-duration-ms <n>] [--test-command <cmd>] [--min-free-disk-gb <n>] [--preflight-report-only] [--open-pr-on-override] [--force-restart <slice|ghIssue>[,...]] [--resume-stuck <slice|ghIssue>[,...]] [--preview-verify-command <cmd> --preview-apply-command <cmd> [--preview-lock-path <path>]]\n       afk status [--run <dir>] [--json]\n       afk status --web [--run <dir>] [--port <number>] [--no-open]\n       afk clean-failed --prd-dir <path-to-prd-folder> [--dry-run]`,
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
    if (args.includes("--web")) {
      try {
        const handle = await runStatusWeb(args.slice(1), resolve("."));
        console.log(`AFK status dashboard: ${handle.url}\nRun: ${handle.runDir}`);
        process.once("SIGINT", () => {
          void handle.close().finally(() => process.exit(0));
        });
        return;
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(2);
      }
    }
    const { output, exitCode } = runStatus(args.slice(1), resolve("."));
    // Error output goes to stderr so it's distinguishable from the
    // rendered view (and from --json documents) in shell pipelines.
    (exitCode === 0 ? console.log : console.error)(output);
    process.exit(exitCode);
  }
  // `clean-failed` removes dead slice worktrees/branches left by
  // failed runs — see issue #19.
  if (args[0] === "clean-failed") {
    process.exit(await runCleanFailedCli(args.slice(1)));
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
  const afkManifest = loadAfkManifest(prdDir);

  const prdSlug = basename(prdDir);
  const specsDir = prdDir
    .replace(repoRoot + "\\", "")
    .replace(repoRoot + "/", "")
    .replace(/\\/g, "/");
  const issuesPath = join(prdDir, "issues.md");

  const slices = parseIssuesMd(issuesPath);
  const dag = buildDAG(slices);
  let runScope;
  try {
    runScope = resolveCliRunScope({
      repoRoot,
      prdSlug,
      provider: kiroProvider,
      slices,
      selectedSliceNumbers,
      manifestSelectedSliceNumbers: afkManifest?.selectedSlices,
      onlyFailed,
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(2);
  }
  const requestedSliceNumbers = runScope.requestedSliceNumbers;
  const previewScope = runScope.scope;
  const priorCompleted = runScope.priorCompleted;

  console.log(`AFK Pipeline`);
  console.log(`  PRD: ${prdSlug}`);
  console.log(`  PRD dir: ${prdDir}`);
  console.log(`  Repo: ${repoRoot}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log(`  Max contract rounds: ${maxContractRounds}`);

  console.log(
    `  Requested slices: ${
      onlyFailed
        ? `--only-failed → ${requestedSliceNumbers?.length ? requestedSliceNumbers.join(", ") : "none (every scope member is recorded PASS)"}`
        : (previewScope.selected.map((slice) => slice.number).join(", ") || "none")
    }`,
  );
  console.log();

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

  // A stop signal fires an AbortController: in-flight agent invocations
  // are killed and unfinished slices are marked CANCELLED in run state.
  // A second signal exits hard. Which signals count — and why Windows
  // needs more than SIGINT — is in src/cancellation.ts (#114).
  const cancellation = installCancellationSignals();
  console.log(
    `Starting pipeline... (${cancellation.signals.join(" / ")} to cancel)\n`,
  );

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
      selectedSliceNumbers: requestedSliceNumbers,
      manifest: afkManifest,
      migrationValidation,
      signal: cancellation.signal,
      ...runtimeOptions,
    });
  } catch (err) {
    cancellation.dispose();
    if (err instanceof PipelineError) {
      console.log("\n" + err.partialResult.consoleSummary);
      console.error("\nPipeline aborted by unhandled error:");
      console.error(err.cause instanceof Error ? err.cause.stack ?? err.cause.message : String(err.cause));
      process.exit(1);
    }
    throw err;
  }

  cancellation.dispose();

  console.log("\n" + result.consoleSummary);

  if (!result.success) {
    console.error("\n" + formatRunFailure(result));
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
