#!/usr/bin/env node
import { resolve, dirname, basename } from "node:path";
import { parseIssuesMd, buildDAG } from "./issues-parser.js";
import { runPipeline } from "./orchestrator.js";
import { claudeProvider } from "./claude.js";

function usage(): never {
  console.error(
    `Usage: afk-claude --issues <path-to-issues.md> [--dry-run]`,
  );
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  let issuesPath: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--issues" && args[i + 1]) {
      issuesPath = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      usage();
    }
  }

  if (!issuesPath) usage();

  const resolvedPath = resolve(issuesPath);
  const repoRoot = resolve(".");

  const specsDir = dirname(resolvedPath)
    .replace(repoRoot + "\\", "")
    .replace(repoRoot + "/", "")
    .replace(/\\/g, "/");
  const prdSlug = basename(specsDir);

  console.log(`AFK Pipeline (Claude Code backend)`);
  console.log(`  PRD: ${prdSlug}`);
  console.log(`  Issues: ${resolvedPath}`);
  console.log(`  Repo: ${repoRoot}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log();

  const slices = parseIssuesMd(resolvedPath);
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

  const result = await runPipeline({
    repoRoot,
    prdSlug,
    specsDir,
    dag,
    dryRun,
    provider: claudeProvider,
    signal: controller.signal,
  });

  process.off("SIGINT", onSigint);

  console.log("\n" + result.summary);

  if (!result.success) {
    console.error(
      "Pipeline completed with failures. Check logs and stuck.md files.",
    );
    process.exit(1);
  }

  console.log("Pipeline completed successfully.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
