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
import {
  DEFAULT_MAX_CONTRACT_ROUNDS,
  parseMaxContractRounds,
  parseSliceSelection,
} from "./cli-options.js";
import { resolveCliRunScope } from "./cli-run-scope.js";
import { parsePipelineRuntimeOptions } from "./cli-options.js";
import { assertPrdNotOnHold } from "./prd-hold.js";
import { runCleanFailedCli } from "./clean-failed.js";
import { codexProvider } from "./codex.js";
import { loadAfkManifest } from "./afk-manifest.js";
import { installCancellationSignals } from "./cancellation.js";
import { runStopCli } from "./stop-command.js";

const MIGRATION_MODES: ReadonlyArray<MigrationValidation> = [
  "skip",
  "local-stack",
  "linked",
];

function usage(): never {
  console.error(
    `Usage: afk-codex --prd-dir <path-to-prd-folder> [--dry-run] [--slices <01,02,...>] [--only-failed] [--max-contract-rounds <n>] [--migration-validation <skip|local-stack|linked>] [--serial-lanes] [--command-timeout-ms <n>] [--heartbeat-interval-ms <n>] [--infrastructure-retries <n>] [--transient-retry-window-ms <n>] [--max-agent-duration-ms <n>] [--test-command <cmd>] [--open-pr-on-override] [--force-restart <slice|ghIssue>[,...]] [--resume-stuck <slice|ghIssue>[,...]] [--preview-verify-command <cmd> --preview-apply-command <cmd> [--preview-lock-path <path>]]\n       afk-codex stop [<prd-slug>] [--run <dir>] [--wait-ms <n>]\n       afk-codex clean-failed --prd-dir <path-to-prd-folder> [--dry-run]`,
  );
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  // Subcommand dispatch (bare first token).
  //
  // `stop` writes the run's stop sentinel — the delivery mechanism that
  // does not depend on a console signal reaching a detached process
  // (ADR 0041). One file written into the run's log dir.
  if (args[0] === "stop") {
    const { output, exitCode } = await runStopCli(args.slice(1), resolve("."));
    (exitCode === 0 ? console.log : console.error)(output);
    process.exit(exitCode);
  }
  // `clean-failed` removes dead slice worktrees/branches left by failed
  // runs — see issue #19.
  if (args[0] === "clean-failed") {
    process.exit(await runCleanFailedCli(args.slice(1), codexProvider));
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
      provider: codexProvider,
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

  console.log(`AFK Pipeline (Codex backend)`);
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
  //
  // `requestStop` is the same button with no signal involved: the
  // pipeline calls it when it finds this run's stop sentinel, which is
  // how `afk-codex stop` reaches a detached run that no console event can
  // be delivered to (ADR 0041).
  const cancellation = installCancellationSignals();
  console.log(
    `Starting pipeline... (${cancellation.signals.join(" / ")} to cancel, ` +
      `or \`afk-codex stop ${prdSlug}\` from another shell)\n`,
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
      provider: codexProvider,
      migrationValidation,
      signal: cancellation.signal,
      requestCancellation: () => cancellation.requestStop("stop sentinel"),
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
