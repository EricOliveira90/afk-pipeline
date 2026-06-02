#!/usr/bin/env node
import { resolve, basename, join } from "node:path";
import { existsSync } from "node:fs";
import { parseIssuesMd, buildDAG } from "./issues-parser.js";
import {
  runPipeline,
  PipelineError,
  type MigrationValidation,
} from "./orchestrator.js";

const MIGRATION_MODES: ReadonlyArray<MigrationValidation> = [
  "skip",
  "local-stack",
  "linked",
];

function usage(): never {
  console.error(
    `Usage: afk --prd-dir <path-to-prd-folder> [--dry-run] [--migration-validation <skip|local-stack|linked>]`,
  );
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  let prdDirArg: string | undefined;
  let dryRun = false;
  let migrationValidation: MigrationValidation | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prd-dir" && args[i + 1]) {
      prdDirArg = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
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
  console.log();

  // Parse issues and build DAG
  const slices = parseIssuesMd(issuesPath);
  const dag = buildDAG(slices);

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
      const ready = dag.ready(completed);
      if (ready.length === 0) break;
      console.log(`  Wave ${wave}:`);
      for (const id of ready) {
        const slice = dag.slices.get(id)!;
        console.log(`    #${id} ${slice.title}`);
        completed.add(id);
      }
      wave++;
    }

    const hitl = [...dag.slices.values()].filter((s) => s.type === "HITL");
    if (hitl.length > 0) {
      console.log(`\n  Skipped (HITL):`);
      for (const s of hitl) console.log(`    #${s.ghIssue} ${s.title}`);
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
      migrationValidation,
      signal: controller.signal,
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
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
